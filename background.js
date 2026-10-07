const TAMU_API_URL =
  "https://chat-api.tamu.ai/openai/chat/completions" +
  "?bypass_system_prompt=false";

const DEFAULT_MODEL =
  "protected.gemini-2.5-flash";

const MAX_VIEWPORT_CAPTURES = 200;
const VIEWPORT_OVERLAP_RATIO = 0.15;

let activeJob = null;

chrome.runtime.onMessage.addListener(
  (message, sender, sendResponse) => {
    if (
      !message ||
      typeof message.type !== "string"
    ) {
      return false;
    }

    if (
      message.type ===
      "START_FULL_PAGE_TRANSLATION"
    ) {
      if (
        activeJob &&
        (
          activeJob.state === "running" ||
          activeJob.state === "cancelling"
        )
      ) {
        sendResponse({
          ok: false,
          error:
            "A full-page translation is already running."
        });

        return false;
      }

      const job =
        createJob(message);

      activeJob = job;

      runFullPageTranslation(job)
        .then(() => {
          sendResponse({
            ok: true,
            job:
              createPublicJob(job)
          });
        })
        .catch((error) => {
          console.error(
            "Full-page translation failed:",
            error
          );

          sendResponse({
            ok: false,
            error:
              error?.message ||
              "Full-page translation failed.",
            job:
              createPublicJob(job)
          });
        });

      /*
       * Keep this event active while the long-running scan is underway.
       */
      return true;
    }

    if (
      message.type ===
      "GET_FULL_PAGE_TRANSLATION_STATUS"
    ) {
      sendResponse({
        ok: true,
        job:
          activeJob
            ? createPublicJob(activeJob)
            : null
      });

      return false;
    }

    if (
      message.type ===
      "CANCEL_FULL_PAGE_TRANSLATION"
    ) {
      if (
        activeJob &&
        activeJob.state === "running"
      ) {
        activeJob.cancelRequested = true;
        activeJob.state = "cancelling";
        activeJob.message =
          "Cancelling after the current request finishes…";
      }

      sendResponse({
        ok: true,
        job:
          activeJob
            ? createPublicJob(activeJob)
            : null
      });

      return false;
    }

    if (
      message.type ===
      "CLEAR_COMIC_OVERLAYS"
    ) {
      clearComicOverlays()
        .then(() => {
          sendResponse({
            ok: true
          });
        })
        .catch((error) => {
          sendResponse({
            ok: false,
            error:
              error?.message ||
              "Could not clear overlays."
          });
        });

      return true;
    }

    return false;
  }
);

function createJob(message) {
  return {
    id:
      createId(),

    state:
      "running",

    message:
      "Preparing the page…",

    model:
      message.model ||
      DEFAULT_MODEL,

    opacity:
      clamp(
        Number(message.opacity),
        0,
        100
      ),

    proofreader:
      message.proofreader === true,

    capturesCompleted:
      0,

    estimatedCaptures:
      0,

    regionsAdded:
      0,

    duplicatesSkipped:
      0,

    hitCaptureLimit:
      false,

    cancelRequested:
      false,

    error:
      "",

    startedAt:
      new Date().toISOString(),

    finishedAt:
      null,

    tabId:
      null,

    windowId:
      null,

    originalScrollX:
      0,

    originalScrollY:
      0,

    capturedUrl:
      "",

    knownRegions:
      []
  };
}

function createPublicJob(job) {
  return {
    id:
      job.id,

    state:
      job.state,

    message:
      job.message,

    capturesCompleted:
      job.capturesCompleted,

    estimatedCaptures:
      job.estimatedCaptures,

    regionsAdded:
      job.regionsAdded,

    duplicatesSkipped:
      job.duplicatesSkipped,

    hitCaptureLimit:
      job.hitCaptureLimit,

    error:
      job.error,

    startedAt:
      job.startedAt,

    finishedAt:
      job.finishedAt
  };
}

async function runFullPageTranslation(job) {
  let tab;

  try {
    tab =
      await getActiveSupportedTab();

    job.tabId = tab.id;
    job.windowId = tab.windowId;
    job.capturedUrl = tab.url;

    await ensureContentScript(tab.id);

    const preparation =
      await chrome.tabs.sendMessage(
        tab.id,
        {
          type:
            "TAMU_COMIC_PREPARE_FULL_SCAN"
        }
      );

    if (!preparation?.ok) {
      throw new Error(
        preparation?.error ||
        "Could not prepare the page."
      );
    }

    job.originalScrollX =
      preparation.originalScrollX;

    job.originalScrollY =
      preparation.originalScrollY;

    job.estimatedCaptures =
      estimateCaptureCount(
        preparation.documentHeight,
        preparation.viewportHeight
      );

    /*
     * Start with a clean overlay layer.
     */
    await chrome.tabs.sendMessage(
      tab.id,
      {
        type:
          "TAMU_COMIC_CLEAR_OVERLAYS"
      }
    );

    let requestedScrollY = 0;
    let previousActualScrollY = -1;

    for (
      let captureIndex = 0;
      captureIndex <
        MAX_VIEWPORT_CAPTURES;
      captureIndex += 1
    ) {
      if (job.cancelRequested) {
        job.state = "cancelled";
        job.message =
          "Translation cancelled.";
        break;
      }

      await ensureTabIsActive(
        tab.id,
        tab.windowId
      );

      job.message =
        `Loading viewport ${captureIndex + 1} of up to ${MAX_VIEWPORT_CAPTURES}…`;

      const viewport =
        await chrome.tabs.sendMessage(
          tab.id,
          {
            type:
              "TAMU_COMIC_SCROLL_AND_MEASURE",

            scrollY:
              requestedScrollY
          }
        );

      if (!viewport?.ok) {
        throw new Error(
          viewport?.error ||
          "Could not scroll the page."
        );
      }

      if (
        viewport.url !==
        job.capturedUrl
      ) {
        throw new Error(
          "The page URL changed while translation was running."
        );
      }

      job.estimatedCaptures =
        estimateCaptureCount(
          viewport.documentHeight,
          viewport.viewportHeight
        );

      job.message =
        `Capturing viewport ${captureIndex + 1} of approximately ${job.estimatedCaptures}…`;

      /*
       * Hide extension UI and previously rendered overlays before capture.
       */
      await chrome.tabs.sendMessage(
        tab.id,
        {
          type:
            "TAMU_COMIC_SET_CAPTURE_MODE",
          enabled: true
        }
      );

      await delay(100);

      let screenshotDataUrl;

      try {
        screenshotDataUrl =
          await chrome.tabs.captureVisibleTab(
            tab.windowId,
            {
              format: "png"
            }
          );
      } finally {
        await sendMessageSafely(
          tab.id,
          {
            type:
              "TAMU_COMIC_SET_CAPTURE_MODE",
            enabled: false
          }
        );
      }

      const screenshotDimensions =
        await getImageDimensions(
          screenshotDataUrl,
          viewport
        );

      job.message =
        `Translating viewport ${captureIndex + 1} of approximately ${job.estimatedCaptures}…`;

      await sendMessageSafely(
        tab.id,
        {
          type:
            "TAMU_COMIC_SHOW_SCAN_STATUS",

          message:
            job.message,

          capturesCompleted:
            job.capturesCompleted,

          estimatedCaptures:
            job.estimatedCaptures,

          maximumCaptures:
            MAX_VIEWPORT_CAPTURES
        }
      );

      const screenshotRegions =
        await requestTranslatedRegions({
          screenshotDataUrl,
          model:
            job.model,
          proofreader:
            job.proofreader,
          screenshotWidth:
            screenshotDimensions.width,
          screenshotHeight:
            screenshotDimensions.height
        });

      const documentRegions =
        convertToDocumentRegions({
          regions:
            screenshotRegions,

          screenshotWidth:
            screenshotDimensions.width,

          screenshotHeight:
            screenshotDimensions.height,

          viewportWidth:
            viewport.viewportWidth,

          viewportHeight:
            viewport.viewportHeight,

          scrollX:
            viewport.scrollX,

          scrollY:
            viewport.scrollY
        });

      const uniqueRegions = [];

      for (
        const region of
        documentRegions
      ) {
        if (
          isDuplicateRegion(
            region,
            job.knownRegions
          )
        ) {
          job.duplicatesSkipped += 1;
          continue;
        }

        job.knownRegions.push(region);
        uniqueRegions.push(region);
      }

      if (uniqueRegions.length > 0) {
        const renderResponse =
          await chrome.tabs.sendMessage(
            tab.id,
            {
              type:
                "TAMU_COMIC_RENDER_DOCUMENT_OVERLAYS",

              regions:
                uniqueRegions,

              opacity:
                job.opacity
            }
          );

        if (!renderResponse?.ok) {
          throw new Error(
            renderResponse?.error ||
            "Could not render the translated overlays."
          );
        }

        job.regionsAdded +=
          renderResponse.regionCount || 0;
      }

      job.capturesCompleted += 1;

      const maximumScrollY =
        Math.max(
          0,
          viewport.documentHeight -
          viewport.viewportHeight
        );

      const reachedBottom =
        viewport.scrollY >=
        maximumScrollY - 2;

      if (reachedBottom) {
        job.state = "completed";
        job.message =
          `Translation complete. Added ${job.regionsAdded} overlays.`;
        break;
      }

      if (
        viewport.scrollY ===
        previousActualScrollY
      ) {
        /*
         * The page refused to scroll farther even though its reported
         * height suggested more content.
         */
        job.state = "completed";
        job.message =
          `Translation stopped because the page could not scroll farther. Added ${job.regionsAdded} overlays.`;
        break;
      }

      previousActualScrollY =
        viewport.scrollY;

      const scrollStep =
        Math.max(
          100,
          Math.floor(
            viewport.viewportHeight *
            (
              1 -
              VIEWPORT_OVERLAP_RATIO
            )
          )
        );

      requestedScrollY =
        Math.min(
          maximumScrollY,
          viewport.scrollY +
          scrollStep
        );

      if (
        captureIndex ===
        MAX_VIEWPORT_CAPTURES - 1
      ) {
        job.hitCaptureLimit = true;
        job.state = "completed";
        job.message =
          `Stopped at the ${MAX_VIEWPORT_CAPTURES}-capture safety limit. Added ${job.regionsAdded} overlays.`;
      }

      /*
       * captureVisibleTab is rate limited. This also reduces visual
       * instability on lazy-loading pages.
       */
      await delay(550);
    }

    if (
      job.state === "running" ||
      job.state === "cancelling"
    ) {
      job.state =
        job.cancelRequested
          ? "cancelled"
          : "completed";
    }
  } catch (error) {
    job.state = "error";
    job.error =
      error?.message ||
      "Full-page translation failed.";

    job.message =
      job.error;

    throw error;
  } finally {
    job.finishedAt =
      new Date().toISOString();

    if (job.tabId) {
      await sendMessageSafely(
        job.tabId,
        {
          type:
            "TAMU_COMIC_FINISH_FULL_SCAN",

          restoreScrollX:
            job.originalScrollX,

          restoreScrollY:
            job.originalScrollY,

          state:
            job.state,

          message:
            job.message,

          regionsAdded:
            job.regionsAdded,

          hitCaptureLimit:
            job.hitCaptureLimit
        }
      );
    }
  }
}

async function clearComicOverlays() {
  const tab =
    await getActiveSupportedTab();

  await ensureContentScript(tab.id);

  await chrome.tabs.sendMessage(
    tab.id,
    {
      type:
        "TAMU_COMIC_CLEAR_OVERLAYS"
    }
  );
}

async function getActiveSupportedTab() {
  const [tab] =
    await chrome.tabs.query({
      active: true,
      currentWindow: true
    });

  if (!tab?.id) {
    throw new Error(
      "No active browser tab was found."
    );
  }

  if (!isSupportedPage(tab.url)) {
    throw new Error(
      "This extension cannot run on this page. Open a normal HTTPS webpage."
    );
  }

  return tab;
}

async function ensureTabIsActive(
  tabId,
  windowId
) {
  const [activeTab] =
    await chrome.tabs.query({
      active: true,
      windowId
    });

  if (
    !activeTab ||
    activeTab.id !== tabId
  ) {
    throw new Error(
      "The comic tab is no longer active. Keep the target tab active while translation runs."
    );
  }
}

function isSupportedPage(url) {
  if (!url) {
    return false;
  }

  const blockedPrefixes = [
    "chrome://",
    "chrome-extension://",
    "edge://",
    "about:",
    "view-source:",
    "devtools://"
  ];

  return !blockedPrefixes.some(
    (prefix) =>
      url.startsWith(prefix)
  );
}

async function ensureContentScript(tabId) {
  try {
    const ping =
      await chrome.tabs.sendMessage(
        tabId,
        {
          type:
            "TAMU_COMIC_PING"
        }
      );

    if (ping?.ok) {
      return;
    }
  } catch {
    /*
     * No active receiver. Inject below.
     */
  }

  try {
    await chrome.scripting.insertCSS({
      target: {
        tabId
      },
      files: [
        "overlay.css"
      ]
    });

    await chrome.scripting.executeScript({
      target: {
        tabId
      },
      files: [
        "content.js"
      ]
    });
  } catch (error) {
    throw new Error(
      "Chrome could not load the translator on this page. " +
      (
        error?.message ||
        "Injection failed."
      )
    );
  }

  await delay(100);

  const ping =
    await chrome.tabs.sendMessage(
      tabId,
      {
        type:
          "TAMU_COMIC_PING"
      }
    );

  if (!ping?.ok) {
    throw new Error(
      "The content script was injected but did not start."
    );
  }
}

async function requestTranslatedRegions({
  screenshotDataUrl,
  model,
  proofreader,
  screenshotWidth,
  screenshotHeight
}) {
  const sessionData =
    await chrome.storage.session.get([
      "tamuApiKey"
    ]);

  const apiKey =
    sessionData.tamuApiKey;

  if (!apiKey) {
    throw new Error(
      "Your TAMU AI API key is unavailable."
    );
  }

  const promptParts = [
    "Analyze this screenshot from a comic, manga, manhwa, or webtoon.",
    "Detect every readable non-English dialogue bubble, caption, label, narration box, and meaningful sound effect.",
    "Translate each detected text region into natural English.",
    "Return strictly valid JSON only. Do not use Markdown or code fences.",
    `The screenshot is exactly ${screenshotWidth} pixels wide and ${screenshotHeight} pixels high.`,
    "Coordinates must be screenshot pixel coordinates.",
    "x and y must be the upper-left corner of the original text.",
    "width and height must tightly cover only the original text area.",
    "Do not merge separate speech bubbles.",
    "Set orientation to vertical only when the source text is primarily vertical.",
    "Use this exact structure:",
    "{\"regions\":[{\"x\":0,\"y\":0,\"width\":100,\"height\":50,\"orientation\":\"horizontal\",\"translatedText\":\"English translation\"}]}",
    "If there is no readable non-English text, return {\"regions\":[]}."
  ];

  if (proofreader) {
    promptParts.push(
      "Silently proofread each English translation.",
      "Correct grammar and awkward phrasing while preserving meaning, names, tone, and intent."
    );
  }

  const requestBody = {
    model,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              promptParts.join("\n")
          },
          {
            type: "image_url",
            image_url: {
              url:
                screenshotDataUrl
            }
          }
        ]
      }
    ],
    temperature:
      proofreader
        ? 0.15
        : 0,
    max_tokens: 5000,
    stream: false
  };

  let response;

  try {
    response = await fetch(
      TAMU_API_URL,
      {
        method: "POST",
        headers: {
          accept:
            "application/json",

          Authorization:
            `Bearer ${apiKey}`,

          "Content-Type":
            "application/json"
        },
        body:
          JSON.stringify(requestBody)
      }
    );
  } catch {
    throw new Error(
      "Could not connect to TAMU AI."
    );
  }

  const rawResponse =
    await response.text();

  const apiData =
    parseApiEnvelope(rawResponse);

  if (!response.ok) {
    throw createApiError(
      response.status,
      apiData,
      model
    );
  }

  const modelText =
    extractModelText(apiData);

  if (!modelText) {
    throw new Error(
      "The model returned no region data."
    );
  }

  const structuredData =
    parseStructuredJSON(modelText);

  return normalizeRegions(
    structuredData,
    screenshotWidth,
    screenshotHeight
  );
}

function convertToDocumentRegions({
  regions,
  screenshotWidth,
  screenshotHeight,
  viewportWidth,
  viewportHeight,
  scrollX,
  scrollY
}) {
  const scaleX =
    viewportWidth /
    screenshotWidth;

  const scaleY =
    viewportHeight /
    screenshotHeight;

  return regions.map(
    (region) => ({
      x:
        scrollX +
        region.x *
        scaleX,

      y:
        scrollY +
        region.y *
        scaleY,

      width:
        region.width *
        scaleX,

      height:
        region.height *
        scaleY,

      orientation:
        region.orientation,

      translatedText:
        region.translatedText
    })
  );
}

function isDuplicateRegion(
  candidate,
  existingRegions
) {
  for (
    const existing of
    existingRegions
  ) {
    const overlap =
      intersectionOverUnion(
        candidate,
        existing
      );

    if (overlap >= 0.35) {
      return true;
    }

    const sameText =
      normalizeText(
        candidate.translatedText
      ) ===
      normalizeText(
        existing.translatedText
      );

    if (sameText) {
      const candidateCenterX =
        candidate.x +
        candidate.width / 2;

      const candidateCenterY =
        candidate.y +
        candidate.height / 2;

      const existingCenterX =
        existing.x +
        existing.width / 2;

      const existingCenterY =
        existing.y +
        existing.height / 2;

      const distance =
        Math.hypot(
          candidateCenterX -
            existingCenterX,
          candidateCenterY -
            existingCenterY
        );

      const tolerance =
        Math.max(
          40,
          Math.max(
            candidate.width,
            candidate.height,
            existing.width,
            existing.height
          )
        );

      if (distance <= tolerance) {
        return true;
      }
    }
  }

  return false;
}

function intersectionOverUnion(
  first,
  second
) {
  const left =
    Math.max(
      first.x,
      second.x
    );

  const top =
    Math.max(
      first.y,
      second.y
    );

  const right =
    Math.min(
      first.x + first.width,
      second.x + second.width
    );

  const bottom =
    Math.min(
      first.y + first.height,
      second.y + second.height
    );

  const intersectionWidth =
    Math.max(0, right - left);

  const intersectionHeight =
    Math.max(0, bottom - top);

  const intersectionArea =
    intersectionWidth *
    intersectionHeight;

  const firstArea =
    first.width *
    first.height;

  const secondArea =
    second.width *
    second.height;

  const unionArea =
    firstArea +
    secondArea -
    intersectionArea;

  if (unionArea <= 0) {
    return 0;
  }

  return intersectionArea /
    unionArea;
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .trim();
}

function estimateCaptureCount(
  documentHeight,
  viewportHeight
) {
  if (
    !documentHeight ||
    !viewportHeight
  ) {
    return MAX_VIEWPORT_CAPTURES;
  }

  const step =
    viewportHeight *
    (
      1 -
      VIEWPORT_OVERLAP_RATIO
    );

  return clamp(
    Math.ceil(
      Math.max(
        1,
        (
          documentHeight -
          viewportHeight
        ) /
        Math.max(1, step) +
        1
      )
    ),
    1,
    MAX_VIEWPORT_CAPTURES
  );
}

async function getImageDimensions(
  imageDataUrl,
  viewport
) {
  try {
    const response =
      await fetch(imageDataUrl);

    const blob =
      await response.blob();

    const bitmap =
      await createImageBitmap(blob);

    const result = {
      width:
        bitmap.width,

      height:
        bitmap.height
    };

    bitmap.close();

    return result;
  } catch {
    const ratio =
      Number(
        viewport.devicePixelRatio
      ) || 1;

    return {
      width:
        Math.round(
          viewport.viewportWidth *
          ratio
        ),

      height:
        Math.round(
          viewport.viewportHeight *
          ratio
        )
    };
  }
}

function parseApiEnvelope(rawResponse) {
  const trimmed =
    rawResponse.trim();

  if (!trimmed) {
    return {};
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    /*
     * Try a streaming response below.
     */
  }

  if (
    trimmed.startsWith("data:") ||
    trimmed.includes("\ndata:")
  ) {
    const textParts = [];

    for (
      const line of
      trimmed.split(/\r?\n/)
    ) {
      const clean =
        line.trim();

      if (
        !clean.startsWith("data:")
      ) {
        continue;
      }

      const payload =
        clean.slice(5).trim();

      if (
        !payload ||
        payload === "[DONE]"
      ) {
        continue;
      }

      try {
        const event =
          JSON.parse(payload);

        appendContent(
          textParts,
          event?.choices?.[0]
            ?.delta?.content
        );

        appendContent(
          textParts,
          event?.choices?.[0]
            ?.message?.content
        );
      } catch {
        /*
         * Ignore malformed event lines.
         */
      }
    }

    return {
      choices: [
        {
          message: {
            content:
              textParts.join("")
          }
        }
      ]
    };
  }

  throw new Error(
    "TAMU AI returned an unreadable response."
  );
}

function appendContent(
  output,
  content
) {
  if (typeof content === "string") {
    output.push(content);
    return;
  }

  if (!Array.isArray(content)) {
    return;
  }

  for (const item of content) {
    if (typeof item === "string") {
      output.push(item);
    } else if (
      typeof item?.text === "string"
    ) {
      output.push(item.text);
    }
  }
}

function extractModelText(data) {
  const content =
    data?.choices?.[0]
      ?.message?.content;

  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }

        return (
          item?.text ||
          item?.content ||
          ""
        );
      })
      .filter(Boolean)
      .join("");
  }

  return data?.output_text || "";
}

function parseStructuredJSON(modelText) {
  const cleaned =
    modelText
      .trim()
      .replace(
        /^```(?:json)?\s*/i,
        ""
      )
      .replace(
        /\s*```$/,
        ""
      )
      .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    /*
     * Extract the largest object.
     */
  }

  const objectStart =
    cleaned.indexOf("{");

  const objectEnd =
    cleaned.lastIndexOf("}");

  if (
    objectStart !== -1 &&
    objectEnd > objectStart
  ) {
    try {
      return JSON.parse(
        cleaned.slice(
          objectStart,
          objectEnd + 1
        )
      );
    } catch {
      /*
       * Continue.
       */
    }
  }

  throw new Error(
    "The model did not return valid bounding-box JSON."
  );
}

function normalizeRegions(
  payload,
  screenshotWidth,
  screenshotHeight
) {
  const source =
    Array.isArray(payload)
      ? payload
      : Array.isArray(
          payload?.regions
        )
        ? payload.regions
        : [];

  return source
    .map((region) => {
      let x =
        Number(region?.x);

      let y =
        Number(region?.y);

      let width =
        Number(region?.width);

      let height =
        Number(region?.height);

      const translatedText =
        String(
          region?.translatedText ??
          region?.translated_text ??
          region?.translation ??
          ""
        ).trim();

      if (
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        !Number.isFinite(width) ||
        !Number.isFinite(height) ||
        !translatedText
      ) {
        return null;
      }

      /*
       * Support normalized coordinates if a model ignores the pixel
       * instruction.
       */
      if (
        x >= 0 &&
        x <= 1 &&
        y >= 0 &&
        y <= 1 &&
        width > 0 &&
        width <= 1 &&
        height > 0 &&
        height <= 1
      ) {
        x *= screenshotWidth;
        width *= screenshotWidth;
        y *= screenshotHeight;
        height *= screenshotHeight;
      }

      x =
        clamp(
          x,
          0,
          screenshotWidth - 1
        );

      y =
        clamp(
          y,
          0,
          screenshotHeight - 1
        );

      width =
        clamp(
          width,
          1,
          screenshotWidth - x
        );

      height =
        clamp(
          height,
          1,
          screenshotHeight - y
        );

      return {
        x,
        y,
        width,
        height,

        orientation:
          String(
            region?.orientation || ""
          ).toLowerCase() ===
          "vertical"
            ? "vertical"
            : "horizontal",

        translatedText
      };
    })
    .filter(Boolean);
}

function createApiError(
  status,
  data,
  model
) {
  const message =
    data?.error?.message ||
    data?.detail ||
    data?.message ||
    data?.error ||
    `HTTP ${status}`;

  const details =
    typeof message === "string"
      ? message
      : JSON.stringify(message);

  if (status === 401) {
    return new Error(
      "TAMU AI rejected the API key."
    );
  }

  if (status === 403) {
    return new Error(
      "TAMU AI denied access to the selected model."
    );
  }

  if (
    status === 400 ||
    status === 422
  ) {
    return new Error(
      `TAMU AI rejected the request for "${model}": ${details}`
    );
  }

  if (status === 429) {
    return new Error(
      "The TAMU AI request limit was reached."
    );
  }

  return new Error(
    `TAMU AI request failed: ${details}`
  );
}

async function sendMessageSafely(
  tabId,
  message
) {
  try {
    return await chrome.tabs.sendMessage(
      tabId,
      message
    );
  } catch (error) {
    console.warn(
      "Could not message the page:",
      error
    );

    return null;
  }
}

function createId() {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID ===
      "function"
  ) {
    return crypto.randomUUID();
  }

  return (
    `${Date.now()}-` +
    Math.random()
      .toString(36)
      .slice(2)
  );
}

function clamp(
  value,
  minimum,
  maximum
) {
  if (!Number.isFinite(value)) {
    return minimum;
  }

  return Math.min(
    maximum,
    Math.max(minimum, value)
  );
}

function delay(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
