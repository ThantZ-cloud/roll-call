const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const path = require("path");
const { initDatabase, query, queryOne, run } = require("./database");
const ExcelJS = require("exceljs");
const os = require("os");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ──────────────────────────────────────────────
// HELPERS
// ──────────────────────────────────────────────

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }
  return "127.0.0.1";
}

function getDateStr() {
  const now = new Date();
  const day = String(now.getDate()).padStart(2, "0");
  const month = now.toLocaleString("en", { month: "short" });
  const year = now.getFullYear();
  return `${day}_${month}_${year}`;
}

// ──────────────────────────────────────────────
// STUDENTS API
// ──────────────────────────────────────────────

app.get("/api/students", (req, res) => {
  const students = query("SELECT * FROM students ORDER BY roll_number");
  res.json(students);
});

app.post("/api/students", (req, res) => {
  const { name, roll_number } = req.body;
  if (!name || !roll_number) {
    return res.status(400).json({ error: "Name and roll number required" });
  }
  try {
    const result = run(
      "INSERT INTO students (name, roll_number) VALUES (?, ?)",
      [name.trim(), roll_number.trim()]
    );
    res.json({ id: result.lastInsertRowid, name: name.trim(), roll_number: roll_number.trim() });
  } catch (err) {
    if (err.message.includes("UNIQUE")) {
      return res.status(400).json({ error: "Roll number already exists" });
    }
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/students/:id", (req, res) => {
  run("DELETE FROM students WHERE id = ?", [parseInt(req.params.id)]);
  res.json({ success: true });
});

app.post("/api/students/bulk", (req, res) => {
  const { students } = req.body;
  if (!Array.isArray(students) || students.length === 0) {
    return res.status(400).json({ error: "Provide an array of students" });
  }
  let added = 0;
  for (const s of students) {
    try {
      run("INSERT OR IGNORE INTO students (name, roll_number) VALUES (?, ?)", [
        s.name.trim(),
        s.roll_number.trim(),
      ]);
      added++;
    } catch (_) {
      // skip duplicates
    }
  }
  res.json({ added, total: students.length });
});

// ──────────────────────────────────────────────
// SUBJECTS API
// ──────────────────────────────────────────────

app.get("/api/subjects", (req, res) => {
  const subjects = query("SELECT * FROM subjects ORDER BY name");
  res.json(subjects);
});

app.post("/api/subjects", (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "Subject name required" });
  try {
    const result = run("INSERT INTO subjects (name) VALUES (?)", [name.trim()]);
    res.json({ id: result.lastInsertRowid, name: name.trim() });
  } catch (err) {
    if (err.message.includes("UNIQUE")) {
      return res.status(400).json({ error: "Subject already exists" });
    }
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/subjects/:id", (req, res) => {
  run("DELETE FROM subjects WHERE id = ?", [parseInt(req.params.id)]);
  res.json({ success: true });
});

// ──────────────────────────────────────────────
// SESSIONS API
// ──────────────────────────────────────────────

app.get("/api/subjects/:id/sessions", (req, res) => {
  const sessions = query(
    `SELECT s.*,
      (SELECT COUNT(*) FROM submissions WHERE session_id = s.id) as present_count,
      (SELECT COUNT(*) FROM students) as total_count
     FROM sessions s
     WHERE s.subject_id = ?
     ORDER BY s.date DESC`,
    [parseInt(req.params.id)]
  );
  res.json(sessions);
});

app.post("/api/sessions", (req, res) => {
  const { subject_id } = req.body;
  if (!subject_id) return res.status(400).json({ error: "Subject ID required" });

  // Close any active session for this subject
  run("UPDATE sessions SET is_active = 0 WHERE subject_id = ? AND is_active = 1", [subject_id]);

  const dateStr = new Date().toISOString().split("T")[0];
  const result = run("INSERT INTO sessions (subject_id, date) VALUES (?, ?)", [subject_id, dateStr]);

  res.json({ id: result.lastInsertRowid, subject_id, date: dateStr, is_active: 1 });
});

app.patch("/api/sessions/:id/end", (req, res) => {
  run("UPDATE sessions SET is_active = 0 WHERE id = ?", [parseInt(req.params.id)]);
  io.emit("session-ended", { session_id: parseInt(req.params.id) });
  res.json({ success: true });
});

app.get("/api/subjects/:id/active-session", (req, res) => {
  const session = queryOne(
    "SELECT * FROM sessions WHERE subject_id = ? AND is_active = 1",
    [parseInt(req.params.id)]
  );
  res.json(session || null);
});

// ──────────────────────────────────────────────
// SUBMISSIONS API
// ──────────────────────────────────────────────

app.get("/api/sessions/:id/submissions", (req, res) => {
  const submissions = query(
    `SELECT sub.id, sub.session_id, sub.student_id, sub.ip_address, sub.method, sub.submitted_at,
            s.name, s.roll_number
     FROM submissions sub
     JOIN students s ON sub.student_id = s.id
     WHERE sub.session_id = ?
     ORDER BY sub.submitted_at`,
    [parseInt(req.params.id)]
  );
  res.json(submissions);
});

// Student self-submit
app.post("/api/sessions/:id/submit", (req, res) => {
  const { student_id } = req.body;
  const session_id = parseInt(req.params.id);
  const ip = req.ip || req.connection.remoteAddress || req.socket.remoteAddress;

  if (!student_id) return res.status(400).json({ error: "Student ID required" });

  // Check session is active
  const session = queryOne("SELECT * FROM sessions WHERE id = ? AND is_active = 1", [session_id]);
  if (!session) return res.status(400).json({ error: "Roll call is not active or has ended" });

  // Check if already submitted by student
  const existing = queryOne(
    "SELECT * FROM submissions WHERE session_id = ? AND student_id = ?",
    [session_id, student_id]
  );
  if (existing) return res.status(400).json({ error: "Already submitted!" });

  // Check if this IP already submitted (anti-cheat)
  const ipUsed = queryOne(
    "SELECT * FROM submissions WHERE session_id = ? AND ip_address = ?",
    [session_id, ip]
  );
  if (ipUsed) return res.status(400).json({ error: "This device has already submitted attendance" });

  try {
    run(
      "INSERT INTO submissions (session_id, student_id, ip_address, method) VALUES (?, ?, ?, 'self')",
      [session_id, student_id, ip]
    );

    const student = queryOne("SELECT name, roll_number FROM students WHERE id = ?", [student_id]);

    const submissionData = {
      session_id,
      student_id,
      name: student.name,
      roll_number: student.roll_number,
      submitted_at: new Date().toISOString(),
    };
    console.log("[Server] Emitting new-submission:", JSON.stringify(submissionData));
    io.emit("new-submission", submissionData);

    res.json({ success: true, message: "Attendance submitted!" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin manual add
app.post("/api/sessions/:id/manual-add", (req, res) => {
  const { student_id } = req.body;
  const session_id = parseInt(req.params.id);

  if (!student_id) return res.status(400).json({ error: "Student ID required" });

  const session = queryOne("SELECT * FROM sessions WHERE id = ? AND is_active = 1", [session_id]);
  if (!session) return res.status(400).json({ error: "Session not active" });

  const existing = queryOne(
    "SELECT * FROM submissions WHERE session_id = ? AND student_id = ?",
    [session_id, student_id]
  );
  if (existing) return res.status(400).json({ error: "Student already marked present" });

  try {
    run(
      "INSERT INTO submissions (session_id, student_id, method) VALUES (?, ?, 'manual')",
      [session_id, student_id]
    );

    const student = queryOne("SELECT name, roll_number FROM students WHERE id = ?", [student_id]);

    io.emit("new-submission", {
      session_id,
      student_id,
      name: student.name,
      roll_number: student.roll_number,
      method: "manual",
      submitted_at: new Date().toISOString(),
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────
// EXPORT TO EXCEL
// ──────────────────────────────────────────────

app.get("/api/sessions/:id/export", async (req, res) => {
  const session_id = parseInt(req.params.id);

  const session = queryOne(
    `SELECT s.*, sub.name as subject_name
     FROM sessions s
     JOIN subjects sub ON s.subject_id = sub.id
     WHERE s.id = ?`,
    [session_id]
  );

  if (!session) return res.status(404).json({ error: "Session not found" });

  const submissions = query(
    `SELECT st.name, st.roll_number, sub.submitted_at, sub.method
     FROM submissions sub
     JOIN students st ON sub.student_id = st.id
     WHERE sub.session_id = ?
     ORDER BY st.roll_number`,
    [session_id]
  );

  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Attendance");

  // Title
  worksheet.mergeCells("A1:D1");
  const titleCell = worksheet.getCell("A1");
  titleCell.value = `${session.subject_name} - Attendance ${session.date}`;
  titleCell.font = { bold: true, size: 14 };
  titleCell.alignment = { horizontal: "center" };

  // Headers
  worksheet.addRow([]);
  const headerRow = worksheet.addRow(["No.", "Student Name", "Roll", "Time"]);
  headerRow.eachCell((cell) => {
    cell.font = { bold: true, size: 12, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF4CAF50" } };
    cell.alignment = { horizontal: "center" };
    cell.border = {
      top: { style: "thin" }, bottom: { style: "thin" },
      left: { style: "thin" }, right: { style: "thin" },
    };
  });

  // Data
  submissions.forEach((sub, i) => {
    const time = sub.submitted_at
      ? new Date(sub.submitted_at).toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit" })
      : "-";
    const row = worksheet.addRow([i + 1, sub.name, sub.roll_number, time]);
    row.eachCell((cell) => {
      cell.border = {
        top: { style: "thin" }, bottom: { style: "thin" },
        left: { style: "thin" }, right: { style: "thin" },
      };
    });
  });

  worksheet.getColumn(1).width = 6;
  worksheet.getColumn(2).width = 25;
  worksheet.getColumn(3).width = 12;
  worksheet.getColumn(4).width = 12;

  const filename = `${session.subject_name}_${getDateStr()}.xlsx`;
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

  await workbook.xlsx.write(res);
  res.end();
});

// ──────────────────────────────────────────────
// PAGES
// ──────────────────────────────────────────────

// Admin dashboard
app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

// ──────────────────────────────────────────────
// SOCKET.IO
// ──────────────────────────────────────────────

io.on("connection", (socket) => {
  console.log("[Socket] Client connected:", socket.id, "— Total:", io.engine.clientsCount);
  socket.on("disconnect", () => {
    console.log("[Socket] Client disconnected:", socket.id);
  });
});

// ──────────────────────────────────────────────
// START
// ──────────────────────────────────────────────

const PORT = 3000;

async function start() {
  await initDatabase();

  server.listen(PORT, "0.0.0.0", () => {
    const ip = getLocalIP();
    console.log("");
    console.log("  Roll Call Server Started!");
    console.log("");
    console.log(`  Local:   http://localhost:${PORT}`);
    console.log(`  Network: http://${ip}:${PORT}`);
    console.log("");
    console.log(`  Students:  http://${ip}:${PORT}`);
    console.log(`  Admin:     http://${ip}:${PORT}/admin`);
    console.log("");
  });
}

start().catch(console.error);
