// Background Service Worker for Office-ChatBox Extension

chrome.runtime.onInstalled.addListener(() => {
  console.log('Office-ChatBox Extension Installed Successfully');
  if (chrome.sidePanel && typeof chrome.sidePanel.setPanelBehavior === 'function') {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
  }
});

// Listen for popup messages to create right-hand floating window
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'OPEN_FLOATING_WINDOW') {
    const targetUrl = request.url || 'http://localhost:3000';
    
    // Calculate right-hand side screen placement
    chrome.windows.getCurrent((currentWindow) => {
      const width = 430;
      const height = 720;
      const screenWidth = currentWindow.width || 1280;
      const left = Math.max(0, screenWidth - width - 40);
      const top = 60;

      chrome.windows.create({
        url: targetUrl,
        type: 'popup',
        width: width,
        height: height,
        left: left,
        top: top,
        focused: true
      }, (win) => {
        sendResponse({ success: true, windowId: win ? win.id : null });
      });
    });
    return true; // Async response
  }
});
