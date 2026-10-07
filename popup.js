const DEFAULT_MODEL =
  "protected.gemini-2.5-flash";

const DEFAULT_OPACITY = 82;
const MAX_CAPTURES = 200;

const apiKeyInput =
  document.getElementById("apiKey");

const modelInput =
  document.getElementById("model");

const opacityInput =
  document.getElementById("opacity");

const opacityValue =
  document.getElementById("opacityValue");

const proofreaderInput =
  document.getElementById("proofreader");

const translateButton =
  document.getElementById("translateButton");

const cancelButton =
  document.getElementById("cancelButton");

const clearButton =
  document.getElementById("clearButton");

const toggleKeyButton =
  document.getElementById("toggleKeyButton");

const progressContainer =
  document.getElementById("progressContainer");

const progressBar =
  document.getElementById("progressBar");

const progressText =
  document.getElementById("progressText");

const statusElement =
  document.getElementById("status");

let pollingTimer = null;

initialize();

async function initialize() {
  try {
    const sessionData =
      await chrome.storage.session.get([
        "tamuApiKey"
      ]);

    const localData =
      await chrome.storage.local.get([
        "comicModel",
        "comicOpacity",
        "comicProofreader"
      ]);

    if (sessionData.tamuApiKey) {
      apiKeyInput.value =
        sessionData.tamuApiKey;
    }

    const savedModel =
      localData.comicModel;

    const modelExists =
      Array.from(modelInput.options).some(
        (option) => option.value === savedModel
      );

    modelInput.value =
      modelExists
        ? savedModel
        : DEFAULT_MODEL;

    const savedOpacity =
      Number(localData.comicOpacity);

    opacityInput.value =
      String(
        Number.isFinite(savedOpacity)
          ? clamp(savedOpacity, 0, 100)
          : DEFAULT_OPACITY
      );

    proofreaderInput.checked =
      localData.comicProofreader === true;

    updateOpacityLabel();

    await refreshJobStatus();
  } catch (error) {
    setStatus(
      error?.message ||
        "Could not load extension settings.",
      true
    );
  }
}

toggleKeyButton.addEventListener(
  "click",
  () => {
    const hidden =
      apiKeyInput.type === "password";

    apiKeyInput.type =
      hidden ? "text" : "password";

    toggleKeyButton.textContent =
      hidden ? "Hide" : "Show";
  }
);

opacityInput.addEventListener(
  "input",
  updateOpacityLabel
);

translateButton.addEventListener(
  "click",
  async () => {
    const apiKey =
      apiKeyInput.value.trim();

    const model =
      modelInput.value ||
      DEFAULT_MODEL;

    const opacity =
      clamp(
        Number(opacityInput.value),
        0,
        100
      );

    if (!apiKey) {
      setStatus(
        "Enter your TAMU AI API key.",
        true
      );

      return;
    }

    const confirmed = window.confirm(
      "Translate the entire page?\n\n" +
      "This can make up to 200 separate screenshot/API requests. " +
      "Long pages may be expensive and take several minutes.\n\n" +
      "Keep the target tab active until translation finishes."
    );

    if (!confirmed) {
      return;
    }

    setStatus("");
    setRunningState(true);

    progressContainer.hidden = false;
    progressBar.style.width = "0%";
    progressText.textContent =
      `Starting scan — maximum ${MAX_CAPTURES} captures`;

    try {
      await chrome.storage.session.set({
        tamuApiKey: apiKey
      });

      await chrome.storage.local.set({
        comicModel: model,
        comicOpacity: opacity,
        comicProofreader:
          proofreaderInput.checked
      });

      startPolling();

      const response =
        await chrome.runtime.sendMessage({
          type:
            "START_FULL_PAGE_TRANSLATION",
          model,
          opacity,
          proofreader:
            proofreaderInput.checked
        });

      if (!response?.ok) {
        throw new Error(
          response?.error ||
            "The full-page translation failed."
        );
      }

      await refreshJobStatus();
    } catch (error) {
      setStatus(
        error?.message ||
          "Could not translate the page.",
        true
      );

      setRunningState(false);
      stopPolling();
    }
  }
);

cancelButton.addEventListener(
  "click",
  async () => {
    cancelButton.disabled = true;

    setStatus(
      "Cancelling after the current request finishes…"
    );

    try {
      await chrome.runtime.sendMessage({
        type:
          "CANCEL_FULL_PAGE_TRANSLATION"
      });
    } catch (error) {
      setStatus(
        error?.message ||
          "Could not cancel the scan.",
        true
      );
    }
  }
);

clearButton.addEventListener(
  "click",
  async () => {
    setControlsDisabled(true);

    try {
      const response =
        await chrome.runtime.sendMessage({
          type: "CLEAR_COMIC_OVERLAYS"
        });

      if (!response?.ok) {
        throw new Error(
          response?.error ||
            "Could not clear overlays."
        );
      }

      setStatus("Overlays cleared.");
    } catch (error) {
      setStatus(
        error?.message ||
          "Could not clear overlays.",
        true
      );
    } finally {
      setControlsDisabled(false);
    }
  }
);

function startPolling() {
  stopPolling();

  pollingTimer = setInterval(
    refreshJobStatus,
    800
  );
}

function stopPolling() {
  if (pollingTimer) {
    clearInterval(pollingTimer);
    pollingTimer = null;
  }
}

async function refreshJobStatus() {
  try {
    const response =
      await chrome.runtime.sendMessage({
        type:
          "GET_FULL_PAGE_TRANSLATION_STATUS"
      });

    const job = response?.job;

    if (!job) {
      setRunningState(false);
      return;
    }

    const running =
      job.state === "running" ||
      job.state === "cancelling";

    setRunningState(running);

    progressContainer.hidden = false;

    const progress =
      calculateProgress(job);

    progressBar.style.width =
      `${progress}%`;

    progressText.textContent =
      job.message ||
      `Capture ${job.capturesCompleted} of ${MAX_CAPTURES}`;

    if (job.state === "completed") {
      setStatus(
        job.hitCaptureLimit
          ? `Finished at the ${MAX_CAPTURES}-capture safety limit.`
          : `Translation complete. Added ${job.regionsAdded} overlays.`
      );

      progressBar.style.width = "100%";
      stopPolling();
    }

    if (job.state === "cancelled") {
      setStatus("Translation cancelled.");
      stopPolling();
    }

    if (job.state === "error") {
      setStatus(
        job.error ||
          "The translation failed.",
        true
      );

      stopPolling();
    }
  } catch {
    /*
     * The popup may briefly lose the service-worker connection.
     * Keep the existing display and retry during the next poll.
     */
  }
}

function calculateProgress(job) {
  if (job.state === "completed") {
    return 100;
  }

  if (
    Number.isFinite(job.estimatedCaptures) &&
    job.estimatedCaptures > 0
  ) {
    return clamp(
      Math.round(
        (
          job.capturesCompleted /
          job.estimatedCaptures
        ) * 100
      ),
      0,
      99
    );
  }

  return clamp(
    Math.round(
      (
        job.capturesCompleted /
        MAX_CAPTURES
      ) * 100
    ),
    0,
    99
  );
}

function setRunningState(running) {
  translateButton.disabled = running;
  cancelButton.disabled = !running;
  clearButton.disabled = running;
  apiKeyInput.disabled = running;
  modelInput.disabled = running;
  opacityInput.disabled = running;
  proofreaderInput.disabled = running;
  toggleKeyButton.disabled = running;
}

function setControlsDisabled(disabled) {
  translateButton.disabled = disabled;
  clearButton.disabled = disabled;
  apiKeyInput.disabled = disabled;
  modelInput.disabled = disabled;
  opacityInput.disabled = disabled;
  proofreaderInput.disabled = disabled;
  toggleKeyButton.disabled = disabled;
}

function updateOpacityLabel() {
  opacityValue.textContent =
    `${opacityInput.value}%`;
}

function setStatus(
  message,
  isError = false
) {
  statusElement.textContent = message;

  statusElement.classList.toggle(
    "error",
    isError
  );
}

function clamp(value, minimum, maximum) {
  return Math.min(
    maximum,
    Math.max(minimum, value)
  );
}
