type PagefindResult = {
  url: string;
  excerpt: string;
  meta: {
    title?: string;
  };
};

type PagefindSearchResponse = {
  results: Array<{
    data: () => Promise<PagefindResult>;
  }>;
};

type PagefindModule = {
  options(options: { bundlePath: string }): Promise<void>;
  init(): Promise<void>;
  debouncedSearch(
    term: string,
    options?: Record<string, unknown>,
    debounceTimeoutMs?: number,
  ): Promise<PagefindSearchResponse | null>;
};

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const classifyUrl = (url: string) => {
  if (url.startsWith("/reference/")) {
    return { label: "API Reference" };
  }
  return { label: "Guide" };
};

let pagefindPromise: Promise<PagefindModule> | undefined;
const dynamicImport = new Function("specifier", "return import(specifier)") as (
  specifier: string,
) => Promise<unknown>;

const loadPagefind = async () => {
  if (!pagefindPromise) {
    pagefindPromise = (async () => {
      const pagefind = (await dynamicImport(
        "/pagefind/pagefind.js",
      )) as PagefindModule;
      await pagefind.options({
        bundlePath: "/pagefind/",
      });
      await pagefind.init();
      return pagefind;
    })();
  }

  return pagefindPromise;
};

const copyBtn = document.querySelector<HTMLElement>("[data-copy-btn]");
if (copyBtn) {
  const box = copyBtn.closest("[data-copy-target]");
  const codeEl = box?.querySelector<HTMLElement>(".landing-copy-text");
  if (codeEl) {
    const handler = () => {
      const text = codeEl.textContent?.trim() ?? "";
      void navigator.clipboard.writeText(text).then(() => {
        copyBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
        setTimeout(() => {
          copyBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
        }, 1500);
      });
    };
    copyBtn.addEventListener("click", handler);
    box?.addEventListener("click", (e) => {
      if (e.target !== copyBtn && !copyBtn.contains(e.target as Node))
        handler();
    });
  }
}

const modal = document.querySelector<HTMLElement>("#search-modal");
const input = document.querySelector<HTMLInputElement>("#search-input");
const results = document.querySelector<HTMLElement>("#search-results");
const status = document.querySelector<HTMLElement>("#search-status");
const backdrop = document.querySelector<HTMLElement>("[data-search-backdrop]");
const openButtons = Array.from(
  document.querySelectorAll<HTMLElement>("[data-search-open]"),
);

if (modal && input && results && status && backdrop) {
  let isOpen = false;

  const setStatus = (message: string) => {
    status.textContent = message;
  };

  const openSearch = async () => {
    if (isOpen) return;
    isOpen = true;
    modal.classList.remove("hidden");
    document.body.classList.add("overflow-hidden");
    setStatus("Loading search index...");
    results.innerHTML = "";
    input.value = "";
    input.focus();
    await loadPagefind();
    setStatus("Start typing to search the docs.");
  };

  const closeSearch = () => {
    if (!isOpen) return;
    isOpen = false;
    modal.classList.add("hidden");
    document.body.classList.remove("overflow-hidden");
  };

  const renderResults = (items: PagefindResult[]) => {
    if (items.length === 0) {
      results.innerHTML = "";
      setStatus("No results matched that search.");
      return;
    }

    setStatus(
      `Showing ${items.length} result${items.length === 1 ? "" : "s"}.`,
    );
    results.innerHTML = items
      .map((item) => {
        const badge = classifyUrl(item.url);
        return `
          <a href="${item.url}" class="search-result-link">
            <div style="margin-bottom:0.5rem;display:flex;align-items:center;gap:0.75rem;">
              <span class="search-result-badge">${badge.label}</span>
              <span class="search-result-url">${escapeHtml(item.url)}</span>
            </div>
            <div class="search-result-title">
              ${escapeHtml(item.meta.title ?? item.url)}
            </div>
            <p class="search-result-excerpt">${item.excerpt}</p>
          </a>
        `;
      })
      .join("");
  };

  const runSearch = async (term: string) => {
    const normalized = term.trim();
    if (!normalized) {
      results.innerHTML = "";
      setStatus("Start typing to search the docs.");
      return;
    }

    setStatus(`Searching for "${normalized}"...`);
    const pagefind = await loadPagefind();
    const search = await pagefind.debouncedSearch(normalized, {}, 200);
    if (!search) {
      return;
    }

    const data = await Promise.all(
      search.results.slice(0, 8).map((result) => result.data()),
    );
    renderResults(data);
  };

  openButtons.forEach((button) => {
    button.addEventListener("click", () => {
      void openSearch();
    });
  });

  backdrop.addEventListener("click", closeSearch);

  input.addEventListener("input", () => {
    void runSearch(input.value);
  });

  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      void openSearch();
      return;
    }

    if (event.key === "/" && document.activeElement !== input) {
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement
      ) {
        return;
      }
      event.preventDefault();
      void openSearch();
      return;
    }

    if (event.key === "Escape") {
      closeSearch();
    }
  });
}
