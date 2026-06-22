# 🌸 Roll Call ❄️

Offline classroom roll call app with Pyin Oo Lwin weather vibes.

**Built for YCC ECs** — manage attendance without internet.

## How It Works

1. **Admin** (EC) turns on phone hotspot & opens the app
2. **Students** connect to WiFi, open browser, select their name
3. **Admin** sees attendance in real-time
4. **Export** to Excel organized by subject & month

## Features

- 🌸 Cherry blossom & snow falling animation (Pyin Oo Lwin vibes!)
- 📱 Students use browser — no app installation needed
- 🔒 Anti-cheat: one submission per student per session
- ➕ Admin can manually add students who can't connect
- 📊 Excel export organized by subject/month
- 📶 Works 100% offline (hotspot only)

## Tech Stack

- **Server:** Node.js + Express + SQLite + Socket.io
- **Student UI:** HTML + CSS + vanilla JS (with falling petals animation)
- **Admin App:** React Native (Expo)
- **Export:** ExcelJS

## Setup

```bash
cd server
npm install
npm start
```

## Project Structure

```
Roll Call/
├── server/           # Express server (runs on admin phone)
│   ├── public/       # Student web form
│   └── ...
├── mobile/           # React Native admin app
└── README.md
```

---

*Made with 🌸 in Pyin Oo Lwin*
