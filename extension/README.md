# 🧩 Office-ChatBox Browser Extension Setup Guide

This browser extension allows you to use **Office-ChatBox** as a popup messenger or floating right-hand screen directly from your Chrome, Edge, Brave, or Opera toolbar!

---

## 🛠️ Step-by-Step: How to Load & Test on Localhost

### 1. Make sure your local server is running:
Open a terminal in `chatbot` folder and start the server:
```bash
npm start
```
Verify that `http://localhost:3000` opens in your browser.

---

### 2. Load the Extension in Chrome / Edge / Brave:

#### For Google Chrome / Brave:
1. Open Google Chrome.
2. Navigate to: `chrome://extensions` in your address bar.
3. In the top-right corner, toggle **Developer mode** to **ON** (blue switch).
4. Click the **Load unpacked** button in the top-left menu.
5. Select the **`extension`** folder inside your `chatbot` project directory (`d:\ANTI GRAVITY APPS\chatbot\extension`).
6. Click **Select Folder**.

#### For Microsoft Edge:
1. Open Microsoft Edge.
2. Navigate to: `edge://extensions` in your address bar.
3. In the bottom-left sidebar, toggle **Developer mode** to **ON**.
4. Click **Load unpacked** at the top.
5. Select the **`extension`** folder inside your `chatbot` project directory (`d:\ANTI GRAVITY APPS\chatbot\extension`).

---

### 3. Pin & Test the Extension:

1. Click the puzzle icon (🧩 **Extensions**) on your browser toolbar (top-right corner).
2. Click the **Pin** icon next to **Office-ChatBox Mini Messenger**.
3. Click the **Office-ChatBox icon** in your toolbar:
   - **Toolbar Popup**: Opens a sleek 420px mini chat window embedded right at the top-right corner!
   - **"Pop-out Right" Button**: Click this button in the popup header to launch a dedicated floating chat screen docked at the **Right Hand Side** corner of your monitor!
   - **Settings (⚙️)**: Switch between `http://localhost:3000` and your deployed Render URL whenever needed.

---

> [!NOTE]
> No code has been pushed to GitHub. This is ready for local testing on `http://localhost:3000`!
