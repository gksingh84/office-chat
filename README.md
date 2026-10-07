# Office-ChatBox 🏢🔒 — Secret Ephemeral Web Messenger

**Office-ChatBox** is a privacy-focused, passkey-protected instant messaging web application designed for office colleagues and friends. It runs in any web browser and allows team members to chat securely over the internet or local office network.

---

## ⚡ Key Features

1. **🔐 Secret Passkey Access**:
   - Only users who possess the master secret passkey can enter and use the app.
   - Access passkey is verified before any chat data or socket stream is unlocked.

2. **🙈 Complete Privacy ("No user should see other users' chats")**:
   - **Private Lounges**: Create custom rooms with optional extra PIN passkeys. Users in Room A cannot view or sniff messages from Room B.
   - **1-on-1 Direct Messaging**: Click any online colleague's alias to initiate a private, isolated 1-on-1 session.

3. **🔥 100% In-Memory Ephemeral Storage**:
   - Zero database logs, zero disk persistence.
   - All messages live strictly in temporary server RAM.
   - **Auto-Delete**: When the application or browser tab is closed, or a room empties, history vanishes forever.
   - **"Burn History" Button**: Immediately purges the room message buffer for all participants.

4. **🪟 Desktop Pop-out Floating Mini Window Mode**:
   - Launch as a compact floating widget window (`430px × 720px`) outside your regular browser tabs.
   - PWA Installable directly to your Windows/Mac Desktop.

5. **✨ Modern Light Theme Aesthetics**:
   - Clean, light slate canvas with ambient soft pastel Orbs and royal indigo & violet accents designed for high office legibility.
   - Supports text, emojis, quick reactions, **ephemeral image attachments**, and **in-browser voice note audio recording**.

---

## 🚀 How to Run Locally

### 1. Install Dependencies
```bash
npm install
```

### 2. Start the Application
```bash
npm start
```

### 3. Open in Browser
Open your browser and navigate to:
```
http://localhost:3000
```
- **Default Secret Passkey**: `passkey4321`

---

## 🌐 How to Share over the Internet with Colleagues

### Option A: Free 24/7 Web Hosting (Render / Glitch)
1. Push this folder to your GitHub repository.
2. Deploy on [Render.com](https://render.com) (Free Web Service) or [Glitch.com](https://glitch.com).
3. Set Environment Variable `PASSKEY` = `your_office_secret_passkey`.
4. Render provides a live HTTPS link (e.g. `https://office-chatbox.onrender.com`). Send it to your colleagues!

### Option B: Instant Local Tunnel
While `npm start` is running, open a second terminal and run:
```bash
npx localtunnel --port 3000
```
Share the generated link (e.g., `https://xxxx.loca.lt`) with your friends!
