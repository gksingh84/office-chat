document.addEventListener('DOMContentLoaded', () => {
  const chatFrame = document.getElementById('chat-frame');
  const frameLoader = document.getElementById('frame-loader');
  const btnPopoutRight = document.getElementById('btn-popout-right');
  const btnToggleSettings = document.getElementById('btn-toggle-settings');
  const settingsPanel = document.getElementById('settings-panel');
  const serverUrlInput = document.getElementById('server-url-input');
  const btnSaveServer = document.getElementById('btn-save-server');
  const statusLabel = document.getElementById('server-status-label');
  const presetChips = document.querySelectorAll('.preset-chip');

  const DEFAULT_URL = 'http://localhost:3000';

  // Load saved Server URL
  chrome.storage.local.get(['serverUrl'], (result) => {
    const currentUrl = result.serverUrl || DEFAULT_URL;
    serverUrlInput.value = currentUrl;
    updateFrameSource(currentUrl);
  });

  function updateFrameSource(url) {
    let cleanUrl = url.trim().replace(/\/+$/, '');
    if (!cleanUrl.startsWith('http://') && !cleanUrl.startsWith('https://')) {
      cleanUrl = 'http://' + cleanUrl;
    }

    try {
      const u = new URL(cleanUrl);
      statusLabel.innerHTML = `<span class="status-dot online"></span> ${u.hostname}${u.port ? ':' + u.port : ''}`;
    } catch(e) {
      statusLabel.innerHTML = `<span class="status-dot"></span> Invalid Host`;
    }

    chatFrame.src = cleanUrl;
  }

  // Toggle Settings Panel
  btnToggleSettings.addEventListener('click', () => {
    settingsPanel.classList.toggle('hidden');
  });

  // Save Server URL
  btnSaveServer.addEventListener('click', () => {
    const newUrl = serverUrlInput.value.trim() || DEFAULT_URL;
    chrome.storage.local.set({ serverUrl: newUrl }, () => {
      updateFrameSource(newUrl);
      settingsPanel.classList.add('hidden');
    });
  });

  // Handle Preset Chips
  presetChips.forEach(chip => {
    chip.addEventListener('click', () => {
      presetChips.forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      const url = chip.dataset.url;
      serverUrlInput.value = url;
      chrome.storage.local.set({ serverUrl: url }, () => {
        updateFrameSource(url);
        settingsPanel.classList.add('hidden');
      });
    });
  });

  // 🚀 LAUNCH FLOATING WINDOW ON RIGHT-HAND CORNER OF SCREEN
  btnPopoutRight.addEventListener('click', () => {
    const targetUrl = serverUrlInput.value.trim() || DEFAULT_URL;

    if (chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage({ type: 'OPEN_FLOATING_WINDOW', url: targetUrl }, (res) => {
        window.close(); // Close extension popup after launching floating window
      });
    } else {
      const width = 430;
      const height = 720;
      const left = window.screen.width - width - 40;
      const top = 60;
      window.open(
        targetUrl,
        'OfficeChatBoxMiniExtensionWindow',
        `width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=no,status=no,toolbar=no,menubar=no`
      );
      window.close();
    }
  });

  // Hide loader once iframe connects
  chatFrame.addEventListener('load', () => {
    frameLoader.classList.add('hidden');
  });
});
