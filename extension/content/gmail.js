(function bootstrapEzSignLauncher() {
  const rootId = "ezsign-launcher-root";

  if (document.getElementById(rootId)) {
    return;
  }

  const host = document.createElement("div");
  host.id = rootId;
  host.style.position = "fixed";
  host.style.right = "24px";
  host.style.bottom = "24px";
  host.style.zIndex = "2147483647";

  const shadowRoot = host.attachShadow({ mode: "open" });
  shadowRoot.innerHTML = `
    <style>
      :host {
        all: initial;
      }

      button {
        border: 0;
        border-radius: 999px;
        background: linear-gradient(135deg, #0f766e, #0ea5e9);
        color: #ffffff;
        cursor: pointer;
        font: 600 13px/1.2 "Segoe UI", system-ui, sans-serif;
        padding: 12px 16px;
        box-shadow: 0 12px 30px rgba(15, 118, 110, 0.28);
      }

      button:hover {
        transform: translateY(-1px);
      }
    </style>
    <button type="button" title="Open EZSign">EZSign</button>
  `;

  const button = shadowRoot.querySelector("button");
  button.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "open-side-panel" });
  });

  document.documentElement.appendChild(host);
})();
