// Offscreen document: giữ timer cho khoảng dừng, không bị service worker MV3 tắt.
let timer = null;

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== 'offscreen') return;
  clearTimeout(timer);
  if (msg.type === 'start') {
    const token = msg.token;
    timer = setTimeout(() => {
      chrome.runtime.sendMessage({ type: 'timerDone', token }).catch(() => {});
    }, Math.max(0, msg.ms));
  }
});

// Báo cho background biết đã sẵn sàng (để nó gửi lại timer nếu document vừa được tạo).
chrome.runtime.sendMessage({ type: 'offscreenReady' }).catch(() => {});
