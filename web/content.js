// Suggest-only: reads the prompt being typed on claude.ai, runs the local
// classifier and shows the suggested model family above the text box. It never
// changes the model, clicks anything or makes a network request.
(() => {
  const classify = globalThis.claudeRouterClassify;
  const tierToFamily = globalThis.claudeRouterTierToFamily;
  if (!classify || !tierToFamily) return;

  const FAMILIES = {
    haiku: { name: "Haiku", color: "#4ade80" },
    sonnet: { name: "Sonnet", color: "#60a5fa" },
    opus: { name: "Opus", color: "#c4b5fd" },
    fable: { name: "Fable", color: "#fdba74" },
  };
  // Any editable text box; no claude.ai-specific selectors, so a page redesign is less likely to break it.
  const EDITABLE = 'textarea, [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]';
  const DEBOUNCE_MS = 150;
  const GAP_PX = 8;

  let target; // the text box being typed in
  let observer; // watches it for changes made without typing (e.g. cleared after sending)
  let timer;
  let host, nameEl, reasonEl;

  function ensureBadge() {
    if (host) return;
    host = document.createElement("div");
    host.style.cssText = "position:fixed;z-index:2147483647;pointer-events:none;display:none;";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        .badge { font: 12px/1.4 system-ui, sans-serif; background: #1f2937; color: #e5e7eb; border-radius: 8px;
                 padding: 5px 10px; box-shadow: 0 2px 8px rgba(0,0,0,.3); max-width: 340px; }
        .name { font-weight: 700; }
        .reason { opacity: .75; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      </style>
      <div class="badge">
        <div>Suggested model: <span class="name"></span></div>
        <div class="reason"></div>
      </div>`;
    nameEl = root.querySelector(".name");
    reasonEl = root.querySelector(".reason");
    document.documentElement.append(host);
  }

  function hide() {
    if (host) host.style.display = "none";
  }

  function promptOf(el) {
    return el instanceof HTMLTextAreaElement ? el.value : el.innerText;
  }

  // The outline of the whole composer (text box plus its toolbar and anything stacked on it):
  // the largest ancestor that is still about as wide as the text box and not much taller.
  function composerRect(el) {
    const base = el.getBoundingClientRect();
    let rect = base;
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const r = p.getBoundingClientRect();
      if (r.width > base.width + 96 || r.height > base.height + 200) break;
      rect = r;
    }
    return rect;
  }

  // Below the composer when there is room, otherwise above it, so it never covers the composer itself.
  function place() {
    if (!host || host.style.display === "none" || !target) return;
    const box = composerRect(target);
    const badge = host.getBoundingClientRect();
    const below = box.bottom + GAP_PX;
    const fitsBelow = below + badge.height + GAP_PX <= window.innerHeight;
    host.style.top = `${fitsBelow ? below : Math.max(GAP_PX, box.top - badge.height - GAP_PX)}px`;
    host.style.left = `${Math.max(GAP_PX, box.right - badge.width)}px`;
  }

  // claude.ai keeps more than one editable element for the composer; only the one
  // actually laid out on screen can anchor the badge.
  function visible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function update() {
    if (!visible(target)) {
      const focused = document.activeElement?.closest?.(EDITABLE);
      if (visible(focused)) target = focused;
      else return hide();
    }
    const prompt = promptOf(target).trim();
    if (!prompt) return hide();

    // The web page has no attached-file size to go on, so pasted text counts as the context.
    const result = classify({ prompt, contextBytes: new TextEncoder().encode(prompt).length });
    // The classifier answers in difficulty tiers; the badge names a model.
    const family = FAMILIES[tierToFamily[result.tier]];
    ensureBadge();
    nameEl.textContent = family.name;
    nameEl.style.color = family.color;
    reasonEl.textContent = result.reasons.join(", ");
    host.style.display = "block";
    place();
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(update, DEBOUNCE_MS);
  }

  function watch(event) {
    const el = event.target instanceof Element ? event.target.closest(EDITABLE) : null;
    if (!el || !visible(el)) return;
    if (el !== target) {
      target = el;
      observer?.disconnect();
      observer = new MutationObserver(schedule);
      observer.observe(el, { childList: true, characterData: true, subtree: true });
    }
    schedule();
  }

  document.addEventListener("input", watch, true);
  document.addEventListener("focusin", watch, true);
  window.addEventListener("resize", place);
  window.addEventListener("scroll", place, true);
})();
