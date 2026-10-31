// The lab's one script, linked by site/layouts/head.ejs with `defer`.
//
// The copy button beside a canary block copies the block's text. Where
// the clipboard is out of reach, it selects the text instead and says
// how to copy it.

// ---- Constants --------------------------------------------------------

const IDLE_LABEL = "Copy canary";

const DONE_LABEL = "Copied";

const SELECTED_LABEL = "Selected. Copy with Ctrl+C or Cmd+C";

const RESET_AFTER_MS = 2400;

// ---- Copy buttons -----------------------------------------------------

function selectText(source) {
  const range = document.createRange();

  range.selectNodeContents(source);

  const selection = getSelection();

  selection.removeAllRanges();
  selection.addRange(range);
}

async function copyFrom(button) {
  const source = document.getElementById(button.dataset.copy);

  try {
    await navigator.clipboard.writeText(source.textContent);
    button.textContent = DONE_LABEL;
    button.dataset.state = "done";
  } catch {
    selectText(source);
    button.textContent = SELECTED_LABEL;
  }

  setTimeout(() => {
    button.textContent = IDLE_LABEL;
    delete button.dataset.state;
  }, RESET_AFTER_MS);
}

for (const button of document.querySelectorAll("[data-copy]")) {
  button.addEventListener("click", () => copyFrom(button));
}
