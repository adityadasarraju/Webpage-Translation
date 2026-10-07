(() => {
  if (
    window.__tamuFullPageComicTranslatorLoaded
  ) {
    return;
  }

  window.__tamuFullPageComicTranslatorLoaded =
    true;

  const OVERLAY_ROOT_ID =
    "__tamu_comic_overlay_root";

  const OVERLAY_CLASS =
    "__tamu_comic_translation_overlay";

  const STATUS_ID =
    "__tamu_comic_scan_status";

  const originalUrl =
    window.location.href;

  let savedScrollBehavior = "";
  let captureModeEnabled = false;

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
        "TAMU_COMIC_PING"
      ) {
        sendResponse({
          ok: true
        });

        return;
      }

      if (
        message.type ===
        "TAMU_COMIC_PREPARE_FULL_SCAN"
      ) {
        prepareFullScan()
          .then((result) => {
            sendResponse({
              ok: true,
              ...result
            });
          })
          .catch((error) => {
            sendResponse({
              ok: false,
              error:
                error?.message ||
                "Could not prepare the page."
            });
          });

        return true;
      }

      if (
        message.type ===
        "TAMU_COMIC_SCROLL_AND_MEASURE"
      ) {
        scrollAndMeasure(
          message.scrollY
        )
          .then((result) => {
            sendResponse({
              ok: true,
              ...result
            });
          })
          .catch((error) => {
            sendResponse({
              ok: false,
              error:
                error?.message ||
                "Could not scroll the page."
            });
          });

        return true;
      }

      if (
        message.type ===
        "TAMU_COMIC_SET_CAPTURE_MODE"
      ) {
        setCaptureMode(
          message.enabled === true
        );

        sendResponse({
          ok: true
        });

        return;
      }

      if (
        message.type ===
        "TAMU_COMIC_RENDER_DOCUMENT_OVERLAYS"
      ) {
        try {
          const count =
            renderDocumentOverlays(
              message.regions,
              message.opacity
            );

          sendResponse({
            ok: true,
            regionCount: count
          });
        } catch (error) {
          sendResponse({
            ok: false,
            error:
              error?.message ||
              "Could not render overlays."
          });
        }

        return;
      }

      if (
        message.type ===
        "TAMU_COMIC_SHOW_SCAN_STATUS"
      ) {
        showScanStatus({
          message:
            message.message,
          capturesCompleted:
            message.capturesCompleted,
          estimatedCaptures:
            message.estimatedCaptures,
          maximumCaptures:
            message.maximumCaptures
        });

        sendResponse({
          ok: true
        });

        return;
      }

      if (
        message.type ===
        "TAMU_COMIC_FINISH_FULL_SCAN"
      ) {
        finishFullScan(message);

        sendResponse({
          ok: true
        });

        return;
      }

      if (
        message.type ===
        "TAMU_COMIC_CLEAR_OVERLAYS"
      ) {
        clearOverlays();

        sendResponse({
          ok: true
        });

        return;
      }

      return false;
    }
  );

  async function prepareFullScan() {
    const originalScrollX =
      window.scrollX;

    const originalScrollY =
      window.scrollY;

    savedScrollBehavior =
      document.documentElement
        .style.scrollBehavior;

    document.documentElement
      .style.scrollBehavior = "auto";

    showScanStatus({
      message:
        "Preparing full-page translation…",
      capturesCompleted: 0,
      estimatedCaptures:
        estimateCaptures(),
      maximumCaptures: 200
    });

    return {
      originalScrollX,
      originalScrollY,

      documentHeight:
        getDocumentHeight(),

      viewportWidth:
        window.innerWidth,

      viewportHeight:
        window.innerHeight,

      url:
        window.location.href
    };
  }

  async function scrollAndMeasure(
    requestedScrollY
  ) {
    const maximumScrollY =
      Math.max(
        0,
        getDocumentHeight() -
        window.innerHeight
      );

    const targetScrollY =
      clamp(
        Number(requestedScrollY),
        0,
        maximumScrollY
      );

    window.scrollTo({
      left: window.scrollX,
      top: targetScrollY,
      behavior: "auto"
    });

    await waitForScrollToSettle();
    await waitForVisibleImages();

    /*
     * Lazy loading may have changed document height.
     */
    await delay(200);

    return {
      viewportWidth:
        window.innerWidth,

      viewportHeight:
        window.innerHeight,

      documentHeight:
        getDocumentHeight(),

      scrollX:
        window.scrollX,

      scrollY:
        window.scrollY,

      devicePixelRatio:
        window.devicePixelRatio || 1,

      unloadedImageCount:
        countUnloadedVisibleImages(),

      url:
        window.location.href
    };
  }

  function setCaptureMode(enabled) {
    captureModeEnabled = enabled;

    const root =
      document.getElementById(
        OVERLAY_ROOT_ID
      );

    const status =
      document.getElementById(
        STATUS_ID
      );

    if (root) {
      root.style.visibility =
        enabled
          ? "hidden"
          : "visible";
    }

    if (status) {
      status.style.visibility =
        enabled
          ? "hidden"
          : "visible";
    }
  }

  function renderDocumentOverlays(
    regions,
    opacity
  ) {
    if (!Array.isArray(regions)) {
      return 0;
    }

    const root =
      getOrCreateOverlayRoot();

    const normalizedOpacity =
      clamp(
        Number(opacity),
        0,
        100
      ) / 100;

    let count = 0;

    for (const region of regions) {
      const x =
        Number(region?.x);

      const y =
        Number(region?.y);

      const width =
        Number(region?.width);

      const height =
        Number(region?.height);

      const translatedText =
        String(
          region?.translatedText || ""
        ).trim();

      if (
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        !Number.isFinite(width) ||
        !Number.isFinite(height) ||
        width < 2 ||
        height < 2 ||
        !translatedText
      ) {
        continue;
      }

      const overlay =
        document.createElement("div");

      overlay.className =
        OVERLAY_CLASS;

      overlay.dataset.orientation =
        region.orientation === "vertical"
          ? "vertical"
          : "horizontal";

      overlay.textContent =
        translatedText;

      Object.assign(
        overlay.style,
        {
          left:
            `${x}px`,

          top:
            `${y}px`,

          width:
            `${width}px`,

          height:
            `${height}px`,

          backgroundColor:
            `rgba(15, 23, 42, ${normalizedOpacity})`
        }
      );

      if (
        region.orientation === "vertical"
      ) {
        overlay.style.writingMode =
          "vertical-rl";

        overlay.style.textOrientation =
          "mixed";
      }

      root.appendChild(overlay);

      fitTextToBox(overlay);

      count += 1;
    }

    return count;
  }

  function getOrCreateOverlayRoot() {
    let root =
      document.getElementById(
        OVERLAY_ROOT_ID
      );

    if (root) {
      return root;
    }

    root =
      document.createElement("div");

    root.id =
      OVERLAY_ROOT_ID;

    Object.assign(root.style, {
      position: "absolute",
      left: "0",
      top: "0",
      width: "0",
      height: "0",
      zIndex: "2147483000",
      pointerEvents: "none",
      visibility:
        captureModeEnabled
          ? "hidden"
          : "visible"
    });

    document.documentElement.appendChild(
      root
    );

    return root;
  }

  function fitTextToBox(element) {
    const vertical =
      element.dataset.orientation ===
      "vertical";

    const width =
      element.clientWidth;

    const height =
      element.clientHeight;

    let fontSize =
      clamp(
        Math.min(
          vertical
            ? width * 0.3
            : height * 0.34,

          vertical
            ? height * 0.11
            : width * 0.11
        ),
        8,
        30
      );

    element.style.fontSize =
      `${fontSize}px`;

    requestAnimationFrame(() => {
      let attempts = 0;

      while (
        attempts < 50 &&
        fontSize > 6 &&
        (
          element.scrollWidth >
            element.clientWidth + 1 ||
          element.scrollHeight >
            element.clientHeight + 1
        )
      ) {
        fontSize -= 0.5;

        element.style.fontSize =
          `${fontSize}px`;

        attempts += 1;
      }
    });
  }

  function showScanStatus({
    message,
    capturesCompleted = 0,
    estimatedCaptures = 0,
    maximumCaptures = 200
  }) {
    let status =
      document.getElementById(
        STATUS_ID
      );

    if (!status) {
      status =
        document.createElement("section");

      status.id =
        STATUS_ID;

      status.innerHTML = `
        <div class="__tamu_status_title">
          Translating page
        </div>

        <div class="__tamu_status_message"></div>

        <div class="__tamu_status_track">
          <div class="__tamu_status_bar"></div>
        </div>

        <div class="__tamu_status_count"></div>
      `;

      document.documentElement.appendChild(
        status
      );
    }

    const messageElement =
      status.querySelector(
        ".__tamu_status_message"
      );

    const bar =
      status.querySelector(
        ".__tamu_status_bar"
      );

    const count =
      status.querySelector(
        ".__tamu_status_count"
      );

    if (messageElement) {
      messageElement.textContent =
        message ||
        "Translating…";
    }

    const divisor =
      estimatedCaptures > 0
        ? estimatedCaptures
        : maximumCaptures;

    const percentage =
      clamp(
        Math.round(
          (
            capturesCompleted /
            Math.max(1, divisor)
          ) * 100
        ),
        0,
        99
      );

    if (bar) {
      bar.style.width =
        `${percentage}%`;
    }

    if (count) {
      count.textContent =
        `Completed ${capturesCompleted} viewport captures · maximum ${maximumCaptures}`;
    }
  }

  function finishFullScan(message) {
    document.documentElement
      .style.scrollBehavior =
      savedScrollBehavior;

    window.scrollTo({
      left:
        Number(
          message.restoreScrollX
        ) || 0,

      top:
        Number(
          message.restoreScrollY
        ) || 0,

      behavior: "auto"
    });

    const status =
      document.getElementById(
        STATUS_ID
      );

    if (!status) {
      return;
    }

    const title =
      status.querySelector(
        ".__tamu_status_title"
      );

    const messageElement =
      status.querySelector(
        ".__tamu_status_message"
      );

    const bar =
      status.querySelector(
        ".__tamu_status_bar"
      );

    if (title) {
      title.textContent =
        message.state === "error"
          ? "Translation failed"
          : message.state === "cancelled"
            ? "Translation cancelled"
            : "Translation complete";
    }

    if (messageElement) {
      messageElement.textContent =
        message.message || "";
    }

    if (
      bar &&
      message.state === "completed"
    ) {
      bar.style.width = "100%";
    }

    status.dataset.state =
      message.state || "";

    setTimeout(() => {
      status.classList.add(
        "__tamu_status_fading"
      );
    }, 4000);

    setTimeout(() => {
      status.remove();
    }, 5000);
  }

  function clearOverlays() {
    document
      .getElementById(
        OVERLAY_ROOT_ID
      )
      ?.remove();

    document
      .getElementById(
        STATUS_ID
      )
      ?.remove();
  }

  async function waitForScrollToSettle() {
    let previousY =
      window.scrollY;

    let stableCount = 0;

    for (
      let attempt = 0;
      attempt < 20;
      attempt += 1
    ) {
      await delay(75);

      const currentY =
        window.scrollY;

      if (
        Math.abs(
          currentY - previousY
        ) < 1
      ) {
        stableCount += 1;

        if (stableCount >= 3) {
          return;
        }
      } else {
        stableCount = 0;
      }

      previousY = currentY;
    }
  }

  async function waitForVisibleImages() {
    const deadline =
      Date.now() + 2500;

    while (
      Date.now() < deadline
    ) {
      if (
        countUnloadedVisibleImages() ===
        0
      ) {
        await delay(250);
        return;
      }

      await delay(150);
    }
  }

  function countUnloadedVisibleImages() {
    let count = 0;

    for (
      const image of
      document.images
    ) {
      const rectangle =
        image.getBoundingClientRect();

      const visible =
        rectangle.bottom > 0 &&
        rectangle.right > 0 &&
        rectangle.top <
          window.innerHeight &&
        rectangle.left <
          window.innerWidth;

      if (
        visible &&
        (
          !image.complete ||
          image.naturalWidth === 0
        )
      ) {
        count += 1;
      }
    }

    return count;
  }

  function getDocumentHeight() {
    return Math.max(
      document.documentElement
        .scrollHeight,

      document.body
        ? document.body.scrollHeight
        : 0,

      document.documentElement
        .offsetHeight,

      document.body
        ? document.body.offsetHeight
        : 0,

      document.documentElement
        .clientHeight
    );
  }

  function estimateCaptures() {
    const height =
      getDocumentHeight();

    const viewport =
      Math.max(
        1,
        window.innerHeight
      );

    const step =
      viewport * 0.85;

    return clamp(
      Math.ceil(
        Math.max(
          1,
          (
            height - viewport
          ) /
          step +
          1
        )
      ),
      1,
      200
    );
  }

  /*
   * Remove overlays after SPA navigation. A normal reload clears the
   * injected DOM automatically.
   */
  let lastUrl =
    originalUrl;

  setInterval(() => {
    if (
      window.location.href !==
      lastUrl
    ) {
      clearOverlays();

      lastUrl =
        window.location.href;
    }
  }, 750);

  function delay(milliseconds) {
    return new Promise((resolve) => {
      setTimeout(resolve, milliseconds);
    });
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
})();
