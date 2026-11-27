---
title: "The Speculation Rules API: Prefetch, Prerender, Eagerness, and How Browsers Make the Next Page Instant"
tag: performance
description: How the Speculation Rules API lets a multi-page site load its next page before the click — list rules and document rules, what prefetch and prerender each do, the four eagerness levels and the FIFO limits Chrome puts on them, what a prerendered page may and may not do before activation, the safety and staleness traps (GET side effects, analytics, carts, No-Vary-Search), cross-origin and CSP rules, how to measure hit rate and activation-based Core Web Vitals, where Safari and Firefox stand at the end of 2026, and a runnable model that compares eagerness levels by hidden latency and wasted bytes
date: "2026-11-27T10:38:00.000Z"
---

## Goal

Most performance work optimizes a page after the user has asked for it: smaller bundles, faster TTFB, better LCP images. Yet the most expensive moment in a multi-page site is often the gap between "the user clicked a link" and "the next document is painted." Every millisecond of DNS, TCP, TLS, server time, HTML parsing, CSS, fonts and JavaScript is paid in full, in series, after the click.

The **Speculation Rules API** moves part of that work before the click. A page declares, as a small JSON document, which URLs the user is likely to visit next and how confident it is. The browser then either **prefetches** the next document into memory or **prerenders** the whole page in an invisible tab and swaps it in on navigation. In the best case LCP after activation is close to zero, because the page was already painted.

This sounds like `<link rel="prefetch">` with better marketing. It is not. The browser, not your script, decides when to act; it knows about hover, pointer-down, viewport position, battery saver and memory pressure; it treats the result as a navigation, not as an HTTP cache entry; and a prerendered page runs under a set of rules that delay intrusive APIs until the user actually sees it.

This article covers:

1. Why the next navigation is the slow part, and what came before speculation rules.
2. The rule syntax: list rules, document rules, and the predicates behind `where`.
3. What prefetch and prerender each do, step by step.
4. Eagerness: `immediate`, `eager`, `moderate`, `conservative`, and Chrome's limits.
5. Life inside a prerendered page: deferred APIs, activation, and storage.
6. The traps: side effects on GET, stale state, analytics, and `No-Vary-Search`.
7. Cross-origin rules, privacy, and Content Security Policy.
8. Measuring: activation time, Core Web Vitals, and hit rate.
9. SPAs, frameworks, CDNs, and WordPress.
10. Where browsers and the specifications stand at the end of 2026.
11. A runnable model that compares eagerness levels.

## 1. Why the next navigation is the slow part

A cold navigation has a critical path that no amount of client-side optimization can parallelize away. The browser cannot request a stylesheet before it has the HTML that references it, cannot run the hydration script before it has downloaded it, and cannot paint the hero image before layout knows where it goes. Each hop on that chain is gated by the previous one.

The web has tried several times to start that chain early:

- **`<link rel="prefetch">`** asks the browser to fetch a resource at low priority into the HTTP cache. It works for subresources, but for documents it has problems. A response with `Cache-Control: no-store` or a short `max-age` is useless when the navigation comes. It also does not know that the resource is a navigation, so cross-site prefetches cannot be handled with navigation-level privacy rules.
- **`<link rel="prerender">`** was a Chrome-only hint that rendered the whole page. It was never broadly supported and gave the author almost no control. Chrome later reinterpreted it as **NoState Prefetch**, which fetches the document and its subresources but does not run JavaScript or render.
- **Libraries** such as quicklink and instant.page injected `<link rel="prefetch">` on hover or when links scrolled into view. They proved that intent signals help, but they were limited to the HTTP cache and to what a script can observe.

Chrome's prerender guide describes the current design as bringing full prerendering back under a new, more expressive mechanism rather than reusing the old `<link rel="prerender">` syntax, which stays as NoState Prefetch. That new mechanism is speculation rules.

## 2. The rule syntax

Rules live either in an inline `<script type="speculationrules">` element or in an external JSON file named by a `Speculation-Rules` response header. The JSON has one array per action, currently `prefetch` and `prerender`, and every element of an array is one rule.

### List rules

A **list rule** names URLs directly:

```html
<script type="speculationrules">
{
  "prerender": [
    { "urls": ["/pricing", "/docs/getting-started"] }
  ],
  "prefetch": [
    { "urls": ["/blog/"], "referrer_policy": "strict-origin-when-cross-origin" }
  ]
}
</script>
```

List rules suit cases where the site knows the next step better than the link layout: the next article in a series, step 2 of a checkout, the search results page whose URL depends on what the user typed. Their default eagerness is `immediate`.

### Document rules

A **document rule** matches links that exist in the current document, using `where`:

```html
<script type="speculationrules">
{
  "prerender": [{
    "where": {
      "and": [
        { "href_matches": "/*" },
        { "not": { "href_matches": "/logout" } },
        { "not": { "href_matches": "/*\\?*(^|&)add-to-cart=*" } },
        { "not": { "selector_matches": ".no-prerender" } },
        { "not": { "selector_matches": "[rel~=nofollow]" } }
      ]
    },
    "eagerness": "moderate"
  }]
}
</script>
```

There are two leaf predicates. `href_matches` takes one or more URL patterns, using the URL Pattern syntax (the same one as `new URLPattern()`), so `/*` means "any same-origin path" and query strings can be matched with a pattern. `selector_matches` takes CSS selectors and is evaluated against the `<a>` or `<area>` element itself. They combine with `and`, `or`, and `not`. Document rules default to `conservative` eagerness, and they keep working as the DOM changes: a link inserted later by `innerHTML` is picked up by an existing rule.

The pattern above is the canonical "speculate everything except" rule. The exclusions are not decoration. A logout link or an add-to-cart GET URL is exactly the kind of navigation you must never fetch speculatively.

### Optional fields

A rule may also carry:

- **`eagerness`**: when to act; see section 4.
- **`referrer_policy`**: a referrer policy for the speculative request only, for example `"no-referrer"` on a rule that prefetches cross-site links, so that the destination does not learn the exact page the link was on before the user has chosen to go there.
- **`relative_to`**: `"document"` makes relative URLs resolve against the document rather than against the external rules file.
- **`requires`**: currently only `"anonymous-client-ip-when-cross-origin"`, which demands that a cross-origin prefetch go through an IP-anonymizing proxy, or not happen at all.
- **`expects_no_vary_search`**: a hint that the response will carry a `No-Vary-Search` header; see section 6.
- **`target_hint`**: `"_blank"` or `"_self"`, so that a list rule can prerender a page that will open in a new tab (Chrome 138, prerender only).
- **`tag`**: a label sent to the server in the `Sec-Speculation-Tags` request header (Chrome 136). CDNs that inject their own rules use it to tell their speculations apart from the site's.

The HTML standard's parsing algorithm is deliberately strict: "unknown keys or invalid values usually cause parsing failure, since it is safer to do nothing than to possibly misinterpret a speculation rule." A typo such as `"eagerniss"` does not degrade to a default. It disables the rule. Chrome DevTools shows the parse error in **Application → Speculative loads**.

### Delivery

Rules can be in `<head>` or `<body>` of the main frame. Rules in iframes are ignored, and rules in a page that is itself prerendering are only acted on after activation. When rules come from JavaScript, the element must be created with `document.createElement('script')` and appended; rules inserted as markup through `innerHTML` are not registered. That also matters for tag managers.

```js
if (HTMLScriptElement.supports?.('speculationrules')) {
  const s = document.createElement('script');
  s.type = 'speculationrules';
  s.textContent = JSON.stringify({
    prefetch: [{ urls: ['/checkout/shipping'], eagerness: 'immediate' }],
  });
  document.head.append(s);
}
```

The header form keeps the document untouched, which is why CDNs like it:

```http
Speculation-Rules: "/speculationrules.json"
```

`Speculation-Rules` is a structured header, so the quotes are required. The file must be served as `application/speculationrules+json`, and if it is cross-origin it must pass CORS. Removing a rules `<script>` cancels the speculations it created, which gives JavaScript a way to retract an `immediate` list.

## 3. What prefetch and prerender do

### Prefetch

A speculation-rules prefetch issues the navigation request that the click would have issued: same URL, same credentials mode, plus the request header `Sec-Purpose: prefetch`. The response body is stored in a **per-document, in-memory** prefetch cache, not in the HTTP cache. Subresources are not fetched. If the user navigates to that URL, the browser uses the stored response and skips the network round trip for the document. HTML parsing, subresource loading, script execution and paint still happen after the click. If the user goes elsewhere, the stored response is discarded when the current page goes away.

Because the cache is navigation-specific, a document that is not HTTP-cacheable can still be prefetched. This is the decisive difference from `<link rel="prefetch">` for HTML pages.

### Prerender

A prerender does the prefetch and then keeps going. The browser creates an invisible top-level browsing context, loads the document into it, fetches subresources, runs JavaScript (including the data fetches that JavaScript starts), lays out and paints. The request carries `Sec-Purpose: prefetch;prerender`. On navigation the browser **activates** that hidden page by swapping it in for the current tab instead of starting a new navigation. If the prerender is still loading when the user clicks, the page is activated in its current state and carries on loading, so a partial prerender still saves time.

MDN puts the cost of a prerender at about the same as rendering an `<iframe>`. It costs memory, CPU, and the full page weight in bandwidth. MDN's advice follows from that: adopt prefetching broadly, and prerender sparingly, where the probability of the navigation is high.

### Prerender until script

Chrome is running an origin trial, from January 2026, for a third action, `prerender_until_script`. It fetches the document and its subresources and starts prerendering, but stops at the first `<script>`. A static page, or one whose scripts sit at the end of `<body>`, gets close to the benefit of a full prerender without running any author JavaScript speculatively. A page with blocking scripts in `<head>` still gets the subresource fetches.

### Response codes

Both actions require a 2xx final response after redirects. Prerender additionally rejects 204 and 205. A server that wants to refuse speculation can therefore look at `Sec-Purpose` and answer 503. Chrome's guide calls this the most reliable way to block a prerender, and also recommends against it in most cases: it is usually better to accept the prerender and delay side effects in JavaScript until activation.

## 4. Eagerness, heuristics, and limits

`eagerness` tells the browser how strong the evidence must be before it acts. The HTML standard defines four values as intent, not as timings:

| Eagerness | Standard's meaning | Chrome's implementation (per Chrome's prerender guide, updated 13 November 2026) |
| --- | --- | --- |
| `immediate` | Very likely worthwhile; act as soon as practical | As soon as the rules are seen |
| `eager` | Even a slight suggestion of intent | Desktop: 10 ms of hover. Mobile: from January 2026, 50 ms after the anchor enters the viewport |
| `moderate` | Behavior suggests a navigation soon | Desktop: 200 ms of hover, or pointer-down if sooner. Mobile: from August 2025, viewport heuristics 500 ms after scrolling stops, for prominent anchors near the last pointer-down |
| `conservative` | The user has begun to interact with a link | Pointer-down or touch-start |

`eager` behaved exactly like `immediate` until Chrome 143. Default eagerness is `immediate` for list rules and `conservative` for document rules.

The gap the eagerness levels exploit is easy to underestimate. A click is pointer-down followed by pointer-up, and the navigation starts on the click, so even `conservative` gets a head start equal to the time the button is held. A 200 ms hover threshold usually starts the request several hundred milliseconds earlier, because people tend to rest on a link before pressing it.

Chrome caps how many speculations can be live at once:

| Eagerness | Prefetch | Prerender |
| --- | ---: | ---: |
| `immediate` | 50 | 10 |
| `eager` / `moderate` on mobile | 6 (FIFO) | 2 (FIFO) |
| `eager` / `moderate` on desktop | 2 (FIFO) | 2 (FIFO) |
| `conservative` | 2 (FIFO) | 2 (FIFO) |

The interaction-driven buckets are first-in, first-out: hovering over a third link cancels the oldest of the two live prerenders. A cancelled speculation can be started again by another hover, and anything cacheable it already downloaded is still in the HTTP cache, so the second attempt is cheaper. The mobile prefetch limit was raised to 6 in Chrome 150 because viewport heuristics are less precise than hover. The `immediate` limit is dynamic: removing a list rule frees its slots.

Chrome also skips speculation entirely under Save-Data, under Energy Saver with a low battery, under memory pressure, when the user has turned off **Preload pages** (extensions such as uBlock Origin turn it off), and for pages in background tabs. A rule is a hint. Your code must work, and your metrics must make sense, when nothing happens.

### Choosing a level

- **Static, light pages** (blogs, docs): `prerender` with `moderate` on document rules is the starting point Chrome's guide calls "basic—yet powerful".
- **Heavy or personalized pages**: `prefetch` with `moderate`, or `conservative` prerender, until analytics show a good hit rate.
- **Known next steps** (pagination, onboarding, checkout): an `immediate` list rule for one or two URLs, plus a `moderate` document rule for everything else.
- **Mobile**: hover does not exist, so `moderate` and `eager` are viewport guesses. Expect lower precision, and favor prefetch.

## 5. Life inside a prerendered page

A prerendered page runs code, but the user cannot see it, so the browser has to stop it from doing anything the user would notice or would not have agreed to. The Prerendering Revamped specification and MDN's list of restricted features describe several groups of behavior.

**Deferred until activation.** Many asynchronous APIs return a pending promise and do nothing until activation, then run normally: geolocation, `Notification.requestPermission()`, `getUserMedia()`, Web MIDI, Web Locks, service worker registration, `BroadcastChannel.postMessage()` and others. An `AudioContext` cannot start, and media playback position does not advance. Dedicated and shared worker scripts are loaded, but their execution waits for activation. Downloads triggered by `<a download>` are held. Cross-origin iframes are not loaded until activation by default. From Chrome 159 an embedding page can opt in with `Supports-Loading-Mode: prerender-cross-origin-frames`.

**Fails or does nothing.** APIs that need user activation (`window.open()`, `requestFullscreen()`, `PaymentRequest.show()`, `navigator.share()`), focus (async Clipboard API), or a visible document (Screen Wake Lock, Picture-in-Picture without user activation) fail in a page that has not been activated. `alert()` returns immediately, `confirm()` returns `false`, `prompt()` returns `""`, and `print()` is ignored.

**Cancels the prerender.** A navigation to another site, or a top-level URL such as `javascript:`, `data:`, `blob:` or `about:blank`, discards the prerender before the request is sent.

**Storage.** `sessionStorage` is per-tab, and two documents in one tab would normally never be live at the same time. The prerendered page therefore starts with a clone of the tab's session storage. On activation the clone is thrown away and the tab's real storage takes over. `localStorage`, IndexedDB and cookies are shared normally, which is precisely why stale state is possible.

Three APIs let a page see where it is in this lifecycle:

```js
// true while the page is in the hidden prerendering context
document.prerendering;

// fires once, when the prerendered page becomes the visible tab
document.addEventListener('prerenderingchange', onActivate, { once: true });

// > 0 after activation: ms from prerender start to activation
performance.getEntriesByType('navigation')[0].activationStart;
```

A small helper covers both prerender and the related case of a tab opened in the background:

```js
export const whenActivated = new Promise((resolve) => {
  if (document.prerendering) {
    document.addEventListener('prerenderingchange', () => resolve(), { once: true });
  } else {
    resolve();
  }
});

export const whenFirstVisible = new Promise((resolve) => {
  if (document.hidden) {
    document.addEventListener('visibilitychange', () => resolve(), { once: true });
  } else {
    resolve();
  }
});
```

`PerformanceNavigationTiming.type` does **not** report `prerender` for these navigations. That value belonged to the legacy `<link rel="prerender">`. Use `document.prerendering` and `activationStart` instead.

## 6. The traps

### Side effects on GET

A speculative request is an ordinary GET with cookies. If `/cart/add?id=42`, `/logout`, `/unsubscribe?token=…` or `/notifications/mark-read` changes server state on GET, a hover can now trigger it. The correct fix is the old one: state changes belong in POST. The pragmatic fix is a `not` predicate in the rule, a `.no-prerender` class on such links, and a server that answers `Sec-Purpose` requests for action URLs with a non-2xx code.

### Server-side counters and logs

Page-view counters, experiment-bucket assignment, "recently viewed" lists, inventory reservations and rate limiters all see the speculative request. If a server action must happen only on a real view, either move it to a client call after activation or skip it when `Sec-Purpose` is present.

### Client-side analytics

Prerendered JavaScript runs. An analytics snippet that sends a page view on load will count pages nobody saw. Chrome's guide notes that Google Analytics, Google Publisher Tag and AdSense already wait for activation. For anything else, gate on `whenActivated`:

```js
async function initAnalytics() {
  await whenActivated;
  analytics.init();
  analytics.page({ prerendered: performance.getEntriesByType('navigation')[0].activationStart > 0 });
}
```

### Stale personalized state

A product page prerendered 20 seconds ago has a cart badge from 20 seconds ago. If the user added an item in between on the current page, the prerendered page is wrong at the moment it is shown. There are three tools, roughly in order of preference:

1. Refresh volatile UI on `prerenderingchange` (and on `visibilitychange`, since back/forward cache and background tabs have the same issue).
2. Broadcast changes from the current page to prerendered ones with `BroadcastChannel`.
3. Return `Clear-Site-Data: "prefetchCache", "prerenderCache"` from the API that changed the state (for example add-to-cart, login, logout). Chrome 138 supports these directives. They cancel the speculations wholesale.

### `No-Vary-Search`

Many URLs differ only in parameters the server ignores, such as `utm_*`, or that only client-side code reads, such as `?id=` on a client-rendered product page. A `No-Vary-Search` response header tells the browser which parameters do not change the response, so a prefetch of `/products` can serve a navigation to `/products?id=123`. Chrome supports this for navigation speculations from Chrome 141. The rule-side `expects_no_vary_search` is only a hint, so that the browser waits for an in-flight prefetch instead of issuing a duplicate request. The server must still send the header.

```html
<script type="speculationrules">
{ "prefetch": [{ "urls": ["/products"], "expects_no_vary_search": "params=(\"id\")" }] }
</script>
```

The caveat is real for prerender. The page may have been prerendered with different parameters, or none. `location.href` shows the prerendered URL until activation, then switches to the final one. Any code that renders from query parameters must run, or rerun, after activation.

## 7. Cross-origin, privacy, and CSP

**Prerender** is same-origin by default. A same-site, cross-origin page (for example `app.example.com` prerendered from `www.example.com`) can be prerendered only if the target opts in with `Supports-Loading-Mode: credentialed-prerender`. Cross-site prerender is not available.

**Prefetch** works same-site cross-origin without restrictions. Cross-site prefetch works only if the user has no cookies for the destination site. Otherwise a prefetch would let a site trigger a credentialed request, and thus a cookie-linked log entry, on a site the user might never visit. With `requires: ["anonymous-client-ip-when-cross-origin"]`, Chrome can route the request through its private prefetch proxy, and it discards the response if cookies turn out to exist, so neither the page nor the proxy learns whether the user has an account elsewhere. A common and safe combination is "prerender same-origin, prefetch the rest":

```html
<script type="speculationrules">
{
  "prerender": [{ "where": { "href_matches": "/*" }, "eagerness": "moderate" }],
  "prefetch":  [{ "where": { "not": { "href_matches": "/*" } }, "eagerness": "moderate" }]
}
</script>
```

The HTML standard also constrains the heuristics behind `moderate` and `eager`. Whether speculation happens is observable by the server, so a user agent may base the decision only on data the origin could already know: author-supplied eagerness, link order, viewport position, cursor proximity, link size. Any persistent state, such as "the user often clicks these links", must be cleared when the user clears site data.

**CSP.** A `<script type="speculationrules">` element is still a script element. A site with `script-src` must allow it by hash or nonce, or with the `'inline-speculation-rules'` source keyword. That keyword covers rules injected by a hashed or nonced script, not rules written into the initial HTML.

## 8. Measuring

**Activation is the start line.** For a prerendered navigation the user's wait starts at activation, not at the original navigation start. Chrome's field data (CrUX) measures Core Web Vitals relative to `activationStart`, which is why a fully prerendered page often reports an LCP of 0. Since version 3.1.0 the `web-vitals` library does the same and reports `navigationType: 'prerender'` for these navigations. A custom RUM script that computes LCP from `navigationStart` will instead credit the prerender with time the user never experienced.

**Prerendering helps more than LCP.** Layout shifts during load happen before the page is shown, so CLS falls. Load-time work has usually finished before the first interaction, which helps INP.

**Segment your data.** Record `activationStart > 0` (or `deliveryType === 'navigational-prefetch'` for prefetches) as a dimension on every page view. Without it, an improving average can hide a cohort that got slower.

**Measure the hit rate.** Fire an event when your page inserts rules (after `HTMLScriptElement.supports('speculationrules')`), and another on activation. The ratio approximates the share of speculations that were used. A requested prerender may never start, so this ratio is a lower bound on browser precision, not a precise count.

**Debug in DevTools.** **Application → Speculative loads** lists every ruleset, parse errors, each candidate URL with its status, and the failure reason for each speculation that did not complete. On the server, `Sec-Purpose` lets you count speculative requests separately.

**Real-world signal.** WordPress's notes for 6.8 report that the sites using the Speculative Loading plugin, more than 50,000 of them, improved their median LCP passing rate by about 1.9% according to HTTP Archive and CrUX, and that over 8% of Chrome navigations used speculation rules by March 2025. These are ecosystem numbers. Your own page weight, server time, and traffic shape decide what you get.

## 9. SPAs, frameworks, CDNs, and WordPress

**SPAs.** Speculation rules only apply to browser-managed document navigations. A client-side route change ("soft navigation") fetches data and swaps DOM inside the current document, so there is nothing to prerender. Framework routers keep their own prefetching: Next.js `<Link>`, Nuxt's link prefetching, React Router loaders, TanStack Router `preload`. Speculation rules can still prerender the SPA's **entry document** from a marketing page. That offsets the app's large first load, which is often its most expensive moment.

**MPAs and islands.** Speculation rules are at their best on server-rendered multi-page sites, including islands architectures such as Astro, where every link is a real navigation. Combined with cross-document View Transitions (`@view-transition { navigation: auto; }`), a prerendered MPA can feel like an SPA without client-side routing.

**CDNs.** Cloudflare's Speed Brain injects conservative prefetch rules at the edge. The `Speculation-Rules` header and `Sec-Speculation-Tags` exist largely for this kind of deployment: the CDN adds rules without editing HTML, then recognizes its own speculative requests and declines those that would reach the origin uncached.

**WordPress.** WordPress 6.8 enabled speculative loading in core for all front ends, except for logged-in users or sites without pretty permalinks. The default is `prefetch` with `conservative` eagerness, matching Cloudflare's default. The earlier feature plugin defaulted to `prerender` with `moderate`, and core chose the safer default for the scale of WordPress, partly because plugins sometimes use GET "action URLs".

## 10. Where browsers and specifications stand

- **Chromium** (Chrome, Edge, Opera) shipped prerender through speculation rules in Chrome 109 and prefetch in Chrome 110. Later additions include eagerness and the header in 121, `tag` in 136, `target_hint` and `Clear-Site-Data` directives in 138, `No-Vary-Search` in 141, the new `eager` in 143, and cross-origin iframe opt-in in 159.
- **Safari**: MDN's browser compatibility data recorded on 12 November 2026 that the "SpeculationRules prefetch" flag is on by default in the Safari 27.3 beta. That covers prefetch, not prerender.
- **Firefox**: prefetch with `urls` lists and `immediate` eagerness, `moderate` eagerness, and the `Speculation-Rules` header are implemented behind `dom.speculation_rules.enabled`. They are on by default in Nightly but not yet in release, as of the Firefox 160 notes, 10 November 2026.
- **Specifications**: the HTML Standard now contains the speculation rules syntax and navigational prefetch. Its parser accepts `prerender` but "optionally" treats it as prefetch, and prerendering itself remains in the WICG **Prerendering Revamped** specification. On a browser that only does prefetch, a prerender rule should therefore degrade to a prefetch.

The practical result: write rules once, gate side effects on `document.prerendering`, and every engine does whatever subset it supports. Engines without support ignore an unknown `<script>` type.

## 11. Trade-offs

| Approach | What happens after the click | Cost if unused | Main risks |
| --- | --- | --- | --- |
| No speculation | Full network + render path | None | — |
| `<link rel="prefetch">` | Render path; document only if HTTP-cacheable | One download into HTTP cache | `no-store` documents wasted; no navigation privacy model |
| Rules `prefetch` | Render path (document already in memory) | One document download | GET side effects; server-side counters |
| Rules `prerender_until_script` | Script and later work | Document + subresources + partial render | Origin trial only |
| Rules `prerender` | Activation swap | Full page load, memory, CPU | All of the above, plus analytics, stale UI, query-dependent rendering |
| Router prefetch (SPA) | Data fetch or code-split chunk may be warm | Framework-dependent | Duplicate data, cache invalidation |

A short decision procedure:

1. Make GET idempotent, and exclude the exceptions in the rule.
2. Gate analytics, ad, and "viewed" side effects on activation.
3. Start with `prefetch` / `moderate` document rules and measure the hit rate.
4. Promote to `prerender` for page types with a high hit rate and stable content.
5. Add a short `immediate` list for steps the product flow already predicts.
6. Add `Clear-Site-Data` or `BroadcastChannel` where state changes invalidate speculations.

## 12. A runnable model

The script below models when speculations start, how much of the navigation they hide, and how many unused speculations each policy issues. Every number in this section comes from running it. It does **not** measure a browser. It encodes assumptions, all set at the top of the file: a 400 ms document fetch, 600 ms of subresources, script and paint after that, an 80 ms gap between pointer-down and click, 60 KB of HTML and a 1,200 KB page, 40 links with Zipf popularity, 0–4 links skimmed before the target, and exponential hover dwell times. The hover thresholds (10 ms and 200 ms), the desktop FIFO limit of 2, and pointer-down triggering for `conservative` follow Chrome's documented behavior. `immediate` is modeled as a list rule naming the 5 most popular links at page load.

In this model a prefetch hides `min(lead, 400)` ms, and a prerender hides `min(lead, 1000)` ms, where *lead* is the time between the speculation starting and the click.

```python
#!/usr/bin/env python3
"""Toy model of Speculation Rules eagerness: when does a speculation start,
how much navigation latency does it hide, and how much does it waste?
All timing and size inputs are assumptions of the model, not measurements."""
import random
import statistics

FETCH_MS = 400        # time to fetch the HTML document
RENDER_MS = 600       # subresources, script and first paint after the HTML arrives
FULL_MS = FETCH_MS + RENDER_MS
DOC_KB = 60           # HTML document size (prefetch cost)
PAGE_KB = 1200        # full page weight incl. subresources (prerender cost)
PRESS_MS = 80         # pointerdown -> click; navigation starts on click
LINKS = 40            # links on the page, popularity follows a Zipf curve
LIST_URLS = 5         # "immediate" list rule names the 5 most popular links
SESSIONS = 20000
HOVER_LIMIT = 2       # Chrome's FIFO limit for eager/moderate/conservative on desktop
HOVER_THRESHOLD = {"eager": 10, "moderate": 200, "conservative": None}


def zipf_weights(n, s=1.1):
    w = [1 / (i + 1) ** s for i in range(n)]
    total = sum(w)
    return [x / total for x in w]


WEIGHTS = zipf_weights(LINKS)


def session(rng):
    """One page view: some links skimmed, then a dwell and a press on the target."""
    target = rng.choices(range(LINKS), WEIGHTS)[0]
    hovers, t = [], rng.uniform(1500, 6000)   # reading time before the first hover
    for _ in range(rng.randint(0, 4)):         # links skimmed but not clicked
        hovers.append((rng.randrange(LINKS), t, rng.expovariate(1 / 250)))
        t += hovers[-1][2] + rng.uniform(100, 800)
    dwell = rng.expovariate(1 / 350)
    hovers.append((target, t, dwell))
    pointerdown = t + dwell
    return hovers, target, pointerdown, pointerdown + PRESS_MS


def hover_rule(policy, hovers, target, pointerdown):
    """Return ({link: start_ms} still alive at click time, set of URLs ever speculated)."""
    th = HOVER_THRESHOLD[policy]
    alive, ever = [], set()
    for link, start, dwell in hovers:
        if th is None:                      # conservative: pointerdown only
            if link != target:
                continue
            fire = pointerdown
        elif dwell >= th:
            fire = start + th
        elif link == target:
            fire = pointerdown              # pointerdown fires before the threshold
        else:
            continue
        if any(l == link for l, _ in alive):
            continue
        ever.add(link)
        alive.append((link, fire))
        if len(alive) > HOVER_LIMIT:
            alive.pop(0)                    # FIFO: the oldest speculation is cancelled
    return dict(alive), ever


def remaining(kind, lead):
    if lead is None:
        return FULL_MS
    if kind == "prefetch":
        return max(0.0, FETCH_MS - lead) + RENDER_MS
    return max(0.0, FULL_MS - lead)


def run(policy, kind, rng):
    rows = []
    for _ in range(SESSIONS):
        hovers, target, pointerdown, click = session(rng)
        alive, ever = {}, set()
        if policy in ("immediate", "immediate+moderate"):
            alive = {i: 0.0 for i in range(LIST_URLS)}   # issued at page load
            ever = set(alive)
        if policy != "immediate":
            h_alive, h_ever = hover_rule(policy.split("+")[-1], hovers, target, pointerdown)
            for link, start in h_alive.items():
                alive.setdefault(link, start)
            ever |= h_ever
        lead = click - alive[target] if target in alive else None
        rows.append((lead is not None, remaining(kind, lead), len(ever) - (lead is not None)))
    lat = sorted(r[1] for r in rows)
    waste = statistics.mean(r[2] for r in rows)
    kb = DOC_KB if kind == "prefetch" else PAGE_KB
    return (sum(r[0] for r in rows) / len(rows), statistics.mean(lat),
            lat[len(lat) // 2], waste, waste * kb)


def main():
    print(f"assumptions: fetch={FETCH_MS}ms render={RENDER_MS}ms press={PRESS_MS}ms "
          f"links={LINKS} list_urls={LIST_URLS} sessions={SESSIONS}")
    print(f"{'kind':9} {'eagerness':19} {'hit':>6} {'mean ms':>8} {'p50 ms':>7} "
          f"{'waste/nav':>9} {'waste KB':>9}")
    for kind in ("prefetch", "prerender"):
        for policy in ("conservative", "moderate", "eager", "immediate", "immediate+moderate"):
            h, mean, p50, w, kb = run(policy, kind, random.Random(172))
            print(f"{kind:9} {policy:19} {h:6.1%} {mean:8.0f} {p50:7.0f} {w:9.2f} {kb:9.0f}")
    print(f"no speculation: every navigation pays {FULL_MS} ms")


if __name__ == "__main__":
    main()
```

Output (`python3 model.py`):

```text
assumptions: fetch=400ms render=600ms press=80ms links=40 list_urls=5 sessions=20000
kind      eagerness              hit  mean ms  p50 ms waste/nav  waste KB
prefetch  conservative        100.0%      920     920      0.00         0
prefetch  moderate            100.0%      801     881      0.86        52
prefetch  eager               100.0%      713     677      1.83       110
prefetch  immediate            58.5%      766     600      4.42       265
prefetch  immediate+moderate  100.0%      684     600      5.18       311
prerender conservative        100.0%      920     920      0.00         0
prerender moderate            100.0%      728     881      0.86      1036
prerender eager               100.0%      588     677      1.83      2202
prerender immediate            58.5%      415       0      4.42      5298
prerender immediate+moderate  100.0%      303       0      5.18      6220
no speculation: every navigation pays 1000 ms
```

The model's rows are easier to read as four findings.

**On desktop, hover-based levels never miss in this model, so they differ in lead time.** Every session ends with a hover and a press on the target, and pointer-down fires the speculation even if the hover threshold was not reached, so `conservative`, `moderate` and `eager` all reach a 100% hit rate. What changes is how early they start. `conservative` gets only the 80 ms press, which saves 80 ms (1000 → 920). `moderate` brings the prerender mean to 728 ms and `eager` to 588 ms. The p50 for `moderate` stays at 881 ms because the median dwell in this model (about 243 ms) is only a little above the 200 ms threshold, so a typical session gains only about 120 ms. Real users who rest on links longer get more. This finding depends on the hover assumption. On mobile there is no hover, viewport heuristics guess, and misses become possible.

**Prefetch has a floor.** No prefetch row goes below 600 ms, because prefetch only removes the document fetch, and the 600 ms of rendering work still follows the click. Prerender can hide all of it. The `immediate` prerender median is 0 ms: when the top-5 list contains the target, the page is ready long before the click.

**Waste grows with eagerness, and prerender multiplies it.** `moderate` speculates on 0.86 unused URLs per navigation and `eager` on 1.83, because skimmed links that cross the threshold count too. The FIFO limit of 2 bounds how many are live at once, not how many are ever started. Each unused prefetch costs a 60 KB document, and each unused prerender a 1,200 KB page. The same 1.83 unused speculations are 110 KB as prefetch and 2,202 KB as prerender.

**Lists buy the biggest saving per hit and pay for every miss.** The top-5 `immediate` list covers 58.5% of clicks under this Zipf distribution. Those navigations are instant, and the other 41.5% pay full price, which gives a mean of 415 ms with 4.42 unused full-page prerenders (5,298 KB) per navigation. Adding a `moderate` document rule catches the rest: 100% hits, a 303 ms mean, and 6,220 KB of waste per navigation. Whether that trade is acceptable depends on data costs and device memory, which is why Chrome caps `immediate` prerenders at 10 and turns all speculation off under Save-Data.

What the model leaves out: pages that are only partly cacheable, server time spent on speculative requests, contention between a prerender and the current page, users who press a link and then cancel (which would give `conservative` some waste), and whatever cancellation reasons a browser applies. Substitute your own fetch time, render time and page weight, and the same procedure will tell you whether your next step is `prefetch`, `prerender`, or a longer dwell threshold.

## Summary

- Speculation rules declare likely next navigations as JSON. **List rules** name URLs and default to `immediate`. **Document rules** match links in the page with `href_matches` (URL Pattern) and `selector_matches` (CSS), combined with `and`, `or` and `not`, and default to `conservative`. Unknown keys or invalid values disable a rule instead of being ignored.
- **Prefetch** stores the next document's response in a per-document memory cache and saves the network round trip. **Prerender** loads, runs and paints the page in a hidden context and swaps it in on activation. Requests carry `Sec-Purpose: prefetch` or `prefetch;prerender`, and a non-2xx answer cancels them.
- **Eagerness** is intent: `immediate`, `eager`, `moderate`, `conservative`. On desktop, Chrome maps these to "as soon as the rules are seen", 10 ms hover, 200 ms hover or pointer-down, and pointer-down. Mobile uses viewport heuristics. Interaction-driven speculations share a FIFO limit of 2 (6 for mobile prefetch), and `immediate` allows 50 prefetches and 10 prerenders.
- A prerendered page runs JavaScript, but intrusive APIs are deferred until activation or fail. Gate analytics and side effects on `document.prerendering` and `prerenderingchange`, refresh volatile UI on activation, and invalidate with `Clear-Site-Data: "prefetchCache", "prerenderCache"` when state changes.
- Prerender is same-origin unless the target sends `Supports-Loading-Mode: credentialed-prerender`. Cross-site prefetch requires that the user have no cookies for the destination. CSP must allow the rules script by hash, nonce or `'inline-speculation-rules'`.
- Measure from `activationStart`, as CrUX and `web-vitals` 3.1.0+ do, segment prerendered views, and track the hit rate. In this post's model the hover-based levels hit every time on desktop and differ in lead time; prefetch cannot go below the 600 ms render floor; an `immediate` top-5 prerender list makes 58.5% of navigations instant, at 4.42 unused full pages per navigation.

## References

- HTML Standard, [Speculative loading](https://html.spec.whatwg.org/multipage/speculative-loading.html) (rule syntax, eagerness definitions, strict parsing, privacy considerations for heuristics)
- WICG, [Prerendering Revamped](https://wicg.github.io/nav-speculation/prerendering.html) and [Speculation Rules](https://wicg.github.io/nav-speculation/speculation-rules.html)
- MDN, [Speculation Rules API](https://developer.mozilla.org/en-US/docs/Web/API/Speculation_Rules_API) (prefetch and prerender behavior, `Sec-Purpose`, unsafe conditions, deferred and restricted features, session storage cloning)
- MDN, [`<script type="speculationrules">`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/script/type/speculationrules)
- Barry Pollard, [Prerender pages in Chrome for instant page navigations](https://developer.chrome.com/docs/web-platform/prerender-pages), Chrome for Developers, last updated 13 November 2026 (eagerness heuristics, limits, header, tags, `target_hint`, `No-Vary-Search`, `prerender_until_script`, cross-origin rules, CSP, analytics and measurement)
- Chrome for Developers, [Guide to implementing speculation rules for more complex sites](https://developer.chrome.com/docs/web-platform/implementing-speculation-rules)
- Chrome for Developers, [Debugging speculation rules](https://developer.chrome.com/docs/devtools/application/debugging-speculation-rules)
- Felix Arntz, [Speculative Loading in 6.8](https://make.wordpress.org/core/2025/03/06/speculative-loading-in-6-8/), Make WordPress Core, 6 March 2025 (core defaults, ~1.9% median LCP passing-rate improvement, over 8% of Chrome navigations)
- MDN browser-compat-data, [Safari 27.3 enables speculation rules](https://github.com/mdn/browser-compat-data/pull/31113), 12 November 2026
- MDN, [Firefox 160 release notes for developers](https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Releases/160) and [Experimental features in Firefox](https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Experimental_features) (`dom.speculation_rules.enabled`)
