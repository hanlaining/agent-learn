const title = document.querySelector("#runtime-title");
const detail = document.querySelector("#runtime-detail");
const indicator = document.querySelector("#runtime-indicator");

const DETAILS = {
  connecting: "正在启动本地 App Server",
  connected: "initialize / initialized 已完成",
  failed: "未向页面暴露内部错误、路径或环境变量",
  closed: "App Server 已安全退出",
};

function renderRuntimeStatus(status) {
  // 全部内容都通过 textContent 写入，避免把 IPC 数据解释为 HTML。
  title.textContent = status.message;
  detail.textContent = DETAILS[status.state] ?? DETAILS.failed;
  indicator.dataset.state = status.state;
}

const removeStatusListener =
  window.godAgent.runtime.onStatusChange(renderRuntimeStatus);

window.godAgent.runtime
  .getStatus()
  .then(renderRuntimeStatus)
  .catch(() => {
    renderRuntimeStatus({
      state: "failed",
      message: "Runtime 连接失败，请关闭后重试",
    });
  });

window.addEventListener("beforeunload", () => {
  removeStatusListener();
}, { once: true });

