"use strict";

// Stats to show in order
const STAT_ROWS = [
    ["articles", "Content pages"],
    ["pages", "Total pages"],
    ["images", "Files"],
    ["edits", "Edits"],
    ["activeusers", "Active users"],
    ["admins", "Admins"],
];

// Wiki farms, matched by host suffix.
// role: origin or destination
// fold: true if lang paths join base URL (example.fandom.com/es)
// api: false means no MediaWiki API
const FARMS = [
    { suffix: "wiki.gg", label: "wiki.gg", role: "destination", fold: true },
    { suffix: "miraheze.org", label: "Miraheze", role: "destination" },
    { suffix: "shoutwiki.com", label: "ShoutWiki", role: "destination" },
    { suffix: "telepedia.net", label: "Telepedia", role: "destination" },
    { suffix: "paradoxwikis.com", label: "Paradox", role: "destination" },
    { suffix: "hoodedhorse.com", label: "Hooded Horse", role: "destination", fold: true },
    { suffix: "fandom.com", label: "Fandom", role: "origin", fold: true },
    { suffix: "neoseeker.com", label: "Neoseeker", role: "origin" },
    { suffix: "fextralife.com", label: "Fextralife", role: "origin", api: false },
];

const ORIGIN_FARM_NAMES = FARMS.filter((farm) => farm.role === "origin").map((farm) => farm.label);
const DATA_URL = "https://api.getindie.wiki/v1/all-data.json";
const TOOL_URL = "https://getindie.wiki/analysis/";
const DATA_REPO = "IndieWikiBuddy/indie-wiki-buddy-data";
const ISSUE_URL = `https://github.com/${DATA_REPO}/issues/new`;
const ISSUE_URL_LIMIT = 6500;

// GitHub sign-in for opening PRs
const OAUTH_CLIENT_ID = "Ov23li9hbUhBNDXYOvAq";
// Cloudflare Worker for GitHub OAuth
const OAUTH_TOKEN_URL = "https://getindie.wiki/oauth/token";
const OAUTH_REVOKE_URL = "https://getindie.wiki/oauth/revoke";
const GITHUB_API = "https://api.github.com";
const GITHUB_TIMEOUT = 30000;

// images.weserv.nl proxy for fetching favicons (CORS workaround)
const ICON_PROXY = "https://images.weserv.nl/?w=16&h=16&fit=inside&output=png&url=";

// Script path for language code
const SCRIPT_PATH_LANG_RE = /^[a-z]{2,3}(?:-[a-z0-9]+)*$/;
// URL segment that looks like a language
const URL_SEGMENT_LANG_RE = /^[a-z]{2}(?:-[a-z0-9]+)*$/;
// Base language code
const BASE_LANG_RE = /^[a-z][a-z0-9]{1,7}$/;

const OFFICIAL_RE = /\bofficial\b/i;

const FETCH_TIMEOUT = 10000;

function farmFor(host) {
    return FARMS.find((farm) => host === farm.suffix || host.endsWith("." + farm.suffix));
}

// Host part of a base URL
// Drops any folded script path
function baseHost(baseUrl) {
    return (baseUrl || "").split("/")[0];
}

function slug(value) {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

// The file to edit in the data repo
function sitesFile(language) {
    return `data/sites${language.toUpperCase()}.json`;
}

function toBaseLanguage(value) {
    const base = value.split("-")[0].toLowerCase();
    return BASE_LANG_RE.test(base) ? base : null;
}

// Collapse whitespace
// Swap out chars that break markdown
// Cap length to 200
function cleanText(value) {
    return value.replace(/\s+/g, " ").trim().replaceAll("`", "'").replaceAll("|", "-").slice(0, 200);
}

// Keep remote text from acting as markdown, mentions, or HTML
function mdEscape(value) {
    return value.replace(/([\\[\]@<>])/g, "\\$1");
}

// Warnings are written as markdown
// plain() strips the backticks for the page
function codeSpan(value) {
    return "`" + cleanText(value) + "`";
}

function plain(value) {
    return value.replaceAll("`", "");
}

function normalizeInputUrl(raw) {
    if (!raw) {
        return null;
    }
    let url = raw.trim().replace(/^<|>$/g, "");
    if (!url.includes("://")) {
        url = "https://" + url;
    }
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        return null;
    }
    if (!["http:", "https:"].includes(parsed.protocol)) {
        return null;
    }
    const labels = parsed.hostname.split(".");
    if (labels.length < 2 || labels[labels.length - 1].length < 2) {
        return null;
    }
    parsed.protocol = "https:";
    return parsed.href;
}

async function fetchJson(url) {
    const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
    if (!response.ok) {
        throw new Error(`status ${response.status}`);
    }
    return response.json();
}

function generalStr(general, key, fallback = "") {
    const value = general[key];
    return typeof value === "string" ? value : fallback;
}

// Probe api.php under every path prefix at once
// Longest first, then /w
// First reply with matching scriptpath wins
async function fetchSiteinfo(parsed) {
    const base = `${parsed.protocol}//${parsed.host}`;
    const segments = parsed.pathname.split("/").filter(Boolean);
    // "/a/b" -> ["/a/b", "/a", ""]
    const prefixes = [];
    for (let i = segments.length; i >= 0; i--) {
        const prefix = segments
            .slice(0, i)
            .map((segment) => "/" + segment)
            .join("");
        prefixes.push(prefix);
    }
    if (!prefixes.includes("/w")) {
        prefixes.push("/w");
    }

    const probes = prefixes.map((prefix) =>
        fetchJson(
            `${base}${prefix}/api.php?action=query&meta=siteinfo&siprop=general%7Cstatistics&format=json&origin=*`
        ).catch(() => null)
    );

    let fallback = null;
    for (const [index, probe] of probes.entries()) {
        const result = await probe;
        if (!result?.query?.general || typeof result.query.general !== "object") {
            continue;
        }
        const scriptpath = generalStr(result.query.general, "scriptpath").replace(/\/+$/, "").toLowerCase();
        if (scriptpath === prefixes[index].toLowerCase()) {
            return result;
        }
        // Wrong-prefix answer, better than nothing
        if (fallback === null) {
            fallback = result;
        }
    }
    return fallback;
}

// No API, so read it off the URL
// Bare host, "/" as content path, and a spaced title
function profileWithoutApi(parsed, farm) {
    const segment = parsed.pathname.split("/").filter(Boolean)[0] || "";
    let title = "";
    try {
        title = cleanText(decodeURIComponent(segment.replaceAll("+", " ")));
    } catch {}

    const warnings = [
        `${farm.label} wikis have no public API, so stats are unavailable and the ` +
            `name and main page come from the pasted URL; check them by hand.`,
    ];
    if (!title) {
        warnings.push(
            `The pasted ${farm.label} URL has no page path; paste the wiki's main ` +
                `page URL to fill in the name and main page.`
        );
    }

    return {
        url: parsed.href,
        warnings,
        stats: {},
        name: title,
        language: "en",
        fullLanguage: "en",
        baseUrl: cleanText(parsed.hostname),
        contentPath: "/",
        mainPage: title || null,
        official: OFFICIAL_RE.test(title),
        farm,
    };
}

// Wiki siteinfo -> profile
// Wikis with no API skip searchPath, platform, generator, and iconUrl
async function profileWiki(url) {
    const parsed = new URL(url);
    const inputFarm = farmFor(parsed.hostname);
    if (inputFarm?.api === false) {
        return profileWithoutApi(parsed, inputFarm);
    }

    const profile = { url, warnings: [], stats: {} };
    const data = await fetchSiteinfo(parsed);
    if (!data) {
        profile.warnings.push(
            `Could not reach a MediaWiki API for ${codeSpan(url)}. The wiki may run ` +
                `other software, block cross-site requests, or be offline. Details and ` +
                `stats need manual review.`
        );
        return profile;
    }

    const general = data.query.general;

    let server;
    try {
        server = new URL(generalStr(general, "server"), url);
    } catch {
        server = new URL(url);
    }
    const host = server.hostname;

    let fullLanguage = generalStr(general, "lang");
    let baseLanguage = toBaseLanguage(fullLanguage);
    if (baseLanguage === null && fullLanguage) {
        profile.warnings.push("The wiki reported an unusable language code; the language needs manual review.");
    }

    const scriptPath = generalStr(general, "scriptpath");
    const variant = scriptPath.replace(/^\/|\/$/g, "").toLowerCase();

    const firstSegment = (parsed.pathname.split("/").filter(Boolean)[0] || "").toLowerCase();
    if (URL_SEGMENT_LANG_RE.test(firstSegment) && variant !== firstSegment && !variant.startsWith(firstSegment + "/")) {
        profile.warnings.push(
            `${codeSpan(url)} has a language path the wiki does not report as a ` +
                `script path; it may be a translated section of one wiki. The base ` +
                `URL, paths, and stats describe the whole wiki, so review them by hand.`
        );
    }

    // Fold a language script path into the base URL (example.fandom.com/es)
    // Fold farms accept any shape (a /lzh wiki can report lang=zh-tw)
    const farm = farmFor(host);
    const folded =
        SCRIPT_PATH_LANG_RE.test(variant) &&
        (variant === fullLanguage.toLowerCase() || variant === baseLanguage || Boolean(farm?.fold));
    if (folded) {
        fullLanguage = variant;
        baseLanguage = variant.split("-")[0];
    }

    const relative = (path) => {
        if (folded && (path === scriptPath || path.startsWith(scriptPath + "/"))) {
            path = path.slice(scriptPath.length);
        }
        return path || "/";
    };

    const articlePath = generalStr(general, "articlepath", "/index.php?title=$1");
    let iconUrl = generalStr(general, "favicon") || generalStr(general, "logo") || null;
    if (iconUrl) {
        try {
            iconUrl = new URL(iconUrl, server).href;
        } catch {
            iconUrl = null;
        }
    }

    const sitename = generalStr(general, "sitename");
    return Object.assign(profile, {
        name: cleanText(sitename),
        language: baseLanguage,
        fullLanguage,
        baseUrl: cleanText(folded ? host + scriptPath : host),
        contentPath: cleanText(relative(articlePath.split("$1")[0])),
        searchPath: cleanText(relative(generalStr(general, "script", scriptPath + "/index.php"))),
        mainPage: cleanText(generalStr(general, "mainpage")).replaceAll(" ", "_"),
        platform: "mediawiki",
        generator: cleanText(generalStr(general, "generator", "MediaWiki")),
        iconUrl,
        stats: data.query.statistics || {},
        official: OFFICIAL_RE.test(sitename),
        farm,
    });
}

function iconFilename(wikiName, baseUrl) {
    const name = wikiName.normalize("NFKD").toLowerCase().replaceAll("wiki.gg", "wiki");
    const stem = slug(name) || slug(baseHost(baseUrl)) || "wiki";
    return stem + ".png";
}

const FARM_SUFFIX_RE = new RegExp(`[\\s_-]*(?:${ORIGIN_FARM_NAMES.join("|")})?[\\s_-]*wikia?$`, "i");

// Normalize to the data's "X Fandom Wiki" convention
function originName(name, farm) {
    if (!name || farm?.role !== "origin") {
        return name;
    }
    let stem = name.replace(FARM_SUFFIX_RE, "").trim();
    stem = stem.replace(/^wikia?[\s:_-]+/i, "").trim();
    return stem ? `${stem} ${farm.label} Wiki` : `${farm.label} Wiki`;
}

// Draft sites entry
function buildEntry(origin, destination, language) {
    const topic = slug(origin.baseUrl.split(".")[0]);
    const label = originName(origin.name, origin.farm);

    const entry = {
        id: `${language}-${topic}`,
        origins_label: label,
        origins: [
            {
                origin: label,
                origin_base_url: origin.baseUrl,
                origin_content_path: origin.contentPath || null,
                origin_main_page: origin.mainPage || null,
            },
        ],
        destination: destination.name || null,
        destination_base_url: destination.baseUrl,
        destination_platform: destination.platform || null,
        destination_icon: iconFilename(destination.name, destination.baseUrl),
        destination_main_page: destination.mainPage || null,
        destination_search_path: destination.searchPath || null,
        destination_content_path: destination.contentPath || null,
    };
    if (destination.farm?.role === "destination") {
        entry.destination_host = destination.farm.label;
    }
    if (destination.official) {
        entry.tags = ["official"];
    }
    return entry;
}

// Compare the draft with existing data
async function checkAgainstData(entry, language) {
    const result = { warnings: [], existing: null, originListed: false };

    let sites;
    try {
        sites = (await fetchJson(DATA_URL)).sites;
    } catch {
        result.warnings.push(
            "Indie Wiki Buddy's data could not be fetched, so the draft was not checked against it."
        );
        return result;
    }
    if (!Array.isArray(sites)) {
        return result;
    }

    const lang = language.toUpperCase();
    if (!sites.some((site) => site.language === lang)) {
        result.warnings.push(`There is no ${sitesFile(language)} yet. This would be the first ${language} wiki.`);
    }

    const originUrl = entry.origins[0].origin_base_url;
    const originEntry = sites.find((site) => site.origins.some((o) => o.origin_base_url === originUrl));
    if (originEntry) {
        let where = "";
        if (originEntry.language !== lang) {
            where = ` in ${codeSpan(sitesFile(originEntry.language))}`;
        }
        const lead =
            `${codeSpan(originUrl)} already redirects to ` +
            `${codeSpan(originEntry.destination_base_url)} (entry ${codeSpan(originEntry.id)}${where})`;
        if (originEntry.destination_base_url === entry.destination_base_url) {
            result.originListed = true;
            result.warnings.push(`${lead}, so no change may be needed.`);
        } else {
            result.warnings.push(
                `${lead}, not to the destination entered here. To change the destination, ` +
                    `edit or replace that entry rather than adding a second one.`
            );
        }
    }

    const existing = sites.find(
        (site) => site.language === lang && site.destination_base_url === entry.destination_base_url
    );
    if (existing) {
        result.existing = existing;
        result.warnings.push(
            `${codeSpan(entry.destination_base_url)} already has entry ` +
                `${codeSpan(result.existing.id)}. Append the origin to its \`origins\` list.`
        );
    }

    if (!result.existing && sites.some((site) => site.id === entry.id)) {
        result.warnings.push(`Entry ID ${codeSpan(entry.id)} is already in use; pick another topic name.`);
    }
    return result;
}

function formatStat(value) {
    return Number.isInteger(value) ? value.toLocaleString("en-US") : "—";
}

function siteSummary(profile) {
    const parts = [profile.generator || "unknown software"];
    if (profile.farm) {
        parts.push(`hosted on ${profile.farm.label}`);
    }
    // No link without a name
    let url = null;
    if (profile.name && !profile.url.includes("(")) {
        url = profile.url;
    }
    return {
        name: profile.name || "(name unknown)",
        url,
        detail: parts.join(", "),
    };
}

function siteLine(label, site) {
    let name = mdEscape(site.name);
    if (site.url) {
        name = `[${name}](${site.url})`;
    }
    return `**${label}:** ${name} — ${mdEscape(site.detail)}`;
}

function hasNull(draft) {
    const values = Object.values(draft);
    if (Array.isArray(draft.origins)) {
        for (const origin of draft.origins) {
            values.push(...Object.values(origin));
        }
    }
    return values.includes(null);
}

// Warnings that need both profiles
function crossWarnings(origin, destination) {
    const warnings = [];
    const originHost = baseHost(origin.baseUrl);
    if (originHost && origin.farm?.role !== "origin") {
        warnings.push(
            `${codeSpan(originHost)} is not on a known origin farm (${ORIGIN_FARM_NAMES.join(", ")}); ` +
                `the data repo's checks reject entries whose origin lives elsewhere.`
        );
    }
    if (origin.fullLanguage && destination.fullLanguage && origin.fullLanguage !== destination.fullLanguage) {
        const sameBase = origin.language === destination.language;
        const difference = sameBase ? "use different dialects" : "have different languages";
        warnings.push(
            `The wikis ${difference}: ` +
                `origin is ${codeSpan(origin.fullLanguage)}, destination is ${codeSpan(destination.fullLanguage)}.`
        );
    }
    return warnings;
}

// Derived once so the page and the markdown cannot drift
function buildView(origin, destination, entry, dataResult, language) {
    const { existing, originListed } = dataResult;

    // The JSON to paste: a new entry, or one origin if the destination exists
    let draft = null;
    if (existing) {
        draft = entry.origins[0];
    } else if (entry) {
        draft = entry;
    }

    const notes = [];
    if (draft && hasNull(draft)) {
        notes.push("The tool could not determine the fields shown as `null`; fill them in by hand.");
    }
    if (entry && !existing && destination.official) {
        notes.push(
            'The destination calls itself "official", so the draft has the `official` tag. Remove it if that is wrong.'
        );
    }

    // Keep the committed filename when replacing an existing icon
    let favicon = null;
    if (entry && destination.iconUrl) {
        favicon = {
            url: ICON_PROXY + encodeURIComponent(destination.iconUrl),
            name: existing ? existing.destination_icon : entry.destination_icon,
        };
    }

    const statRows = [];
    for (const [key, label] of STAT_ROWS) {
        if (key in origin.stats || key in destination.stats) {
            statRows.push([label, formatStat(origin.stats[key]), formatStat(destination.stats[key])]);
        }
    }

    let draftTitle = "Draft entry";
    if (existing) {
        const verb = originListed ? "compare with" : "append to";
        draftTitle = `Draft origin to ${verb} ${codeSpan(existing.id)}`;
    }

    return {
        sites: [
            ["Origin", siteSummary(origin)],
            ["Destination", siteSummary(destination)],
        ],
        favicon,
        statRows,
        warnings: [
            ...origin.warnings,
            ...destination.warnings,
            ...dataResult.warnings,
            ...crossWarnings(origin, destination),
        ],
        existing,
        draft,
        draftTitle,
        language,
        notes,
        entry,
        originListed,
        issue: {
            title: `Add a wiki redirect: ${destination.name || destination.baseUrl || "PUT WIKI NAME HERE"}`,
            origin: origin.url,
            destination: destination.url,
        },
    };
}

function buildMarkdown(view, forPr = false) {
    const lines = [];
    if (forPr) {
        lines.push(`<sub>This PR was generated via the [Indie Wiki Buddy wiki analysis tool](${TOOL_URL}).</sub>`, "");
    } else {
        lines.push(
            "## Wiki comparison",
            `<sub>Generated via [Indie Wiki Buddy wiki analysis tool](${TOOL_URL})</sub>`,
            ""
        );
    }
    for (const [label, site] of view.sites) {
        lines.push(siteLine(label, site));
    }
    lines.push("");

    if (view.statRows.length) {
        lines.push("| Statistic | Origin | Destination |", "| --- | ---: | ---: |");
        for (const row of view.statRows) {
            lines.push(`| ${row.join(" | ")} |`);
        }
        lines.push("");
    }

    if (view.warnings.length) {
        lines.push("### ⚠ Notes");
        for (const warning of view.warnings) {
            lines.push(`- ${warning}`);
        }
        lines.push("");
    }

    if (view.draft && !forPr) {
        const preposition = view.existing ? "in" : "for";
        lines.push(`### ${view.draftTitle} ${preposition} \`${sitesFile(view.language)}\``);
        lines.push("```json", JSON.stringify(view.draft, null, 2), "```", "");
        for (const note of view.notes) {
            lines.push(`- ${note}`);
        }
    }

    return lines.join("\n").trimEnd();
}

const form = document.getElementById("form");
const originInput = document.getElementById("origin");
const destinationInput = document.getElementById("destination");
const submit = document.getElementById("submit");
const status = document.getElementById("status");
const results = document.getElementById("results");
const overview = document.getElementById("overview");
const statsTable = document.getElementById("stats");
const statsBody = statsTable.querySelector("tbody");
const warningsBox = document.getElementById("warnings");
const warningsList = warningsBox.querySelector("ul");
const draftBox = document.getElementById("draft");
const draftTitle = document.getElementById("draft-title");
const draftJson = document.getElementById("draft-json");
const draftError = document.getElementById("draft-error");
const draftNotesBox = document.getElementById("draft-notes");
const faviconBox = document.getElementById("favicon");
const faviconActual = document.getElementById("favicon-actual");
const faviconDownload = document.getElementById("favicon-download");
const copyButton = document.getElementById("copy");
const issueLink = document.getElementById("issue-link");
const issueNote = document.getElementById("issue-note");
const submitBox = document.getElementById("submit-box");
const prIntro = document.getElementById("pr-intro");
const prButton = document.getElementById("pr-button");
const prLink = document.getElementById("pr-link");
const prStatusBox = document.getElementById("pr-status");
const markdownFallback = document.getElementById("markdown-fallback");
const accountText = document.getElementById("account-text");
const accountButton = document.getElementById("account-button");
let lastView = null;
let faviconObjectUrl = null;
let faviconRun = 0; // Counts favicon fetches (avoids slow calls overwriting new ones)
let faviconReady = Promise.resolve(null); // Resolves to favicon blob or null
let ghToken = null; // GitHub token (kept in-ememory)
let ghUser = null; // GitHub username
let prBusy = false; // True while PR is being create

const params = new URLSearchParams(location.search);
originInput.value = params.get("origin") ?? "";
destinationInput.value = params.get("destination") ?? "";

function setStatus(text) {
    status.textContent = text;
}

function renderOverviewLine(label, site) {
    const p = document.createElement("p");
    const strong = document.createElement("strong");
    strong.textContent = `${label}: `;
    p.append(strong);
    if (site.url) {
        const a = document.createElement("a");
        a.href = site.url;
        a.target = "_blank";
        a.rel = "noopener";
        a.textContent = site.name;
        p.append(a);
    } else {
        p.append(site.name);
    }
    p.append(` — ${site.detail}`);
    return p;
}

function render(view) {
    overview.replaceChildren(...view.sites.map(([label, site]) => renderOverviewLine(label, site)));

    statsBody.replaceChildren();
    for (const row of view.statRows) {
        const tr = document.createElement("tr");
        for (const text of row) {
            const td = document.createElement("td");
            td.textContent = text;
            tr.append(td);
        }
        statsBody.append(tr);
    }
    statsTable.hidden = !view.statRows.length;

    warningsList.replaceChildren();
    for (const warning of view.warnings) {
        const li = document.createElement("li");
        li.textContent = plain(warning);
        warningsList.append(li);
    }
    warningsBox.hidden = !view.warnings.length;

    if (view.draft) {
        draftTitle.textContent = plain(view.draftTitle);
        draftJson.value = JSON.stringify(view.draft, null, 2);
        draftJson.rows = Math.min(draftJson.value.split("\n").length + 1, 24);
        draftError.textContent = "";
        draftNotesBox.textContent = plain(view.notes.join(" "));
        draftBox.hidden = false;
    } else {
        draftBox.hidden = true;
    }

    prLink.hidden = true;
    updatePrArea(view);
    results.hidden = false;
}

function issueUrl(analysis) {
    const params = new URLSearchParams({
        template: "request-a-wiki-be-added.yml",
        title: lastView.issue.title,
        origin: lastView.issue.origin,
        destination: lastView.issue.destination,
    });
    if (analysis) {
        params.set("analysis", analysis);
    }
    return `${ISSUE_URL}?${params}`;
}

function refreshMarkdown() {
    // Prefill GH issue form
    let url = issueUrl(buildMarkdown(lastView));
    const tooLong = url.length > ISSUE_URL_LIMIT;
    if (tooLong) {
        url = issueUrl(null);
    }
    issueLink.href = url;
    issueNote.hidden = !tooLong;
}

// Show converted favicon
async function loadFavicon(favicon) {
    const run = ++faviconRun;
    faviconBox.hidden = true;
    if (faviconObjectUrl) {
        URL.revokeObjectURL(faviconObjectUrl);
    }
    faviconObjectUrl = null;
    if (!favicon) {
        return null;
    }

    let blob;
    try {
        const response = await fetch(favicon.url);
        if (!response.ok) {
            return null;
        }
        blob = await response.blob();
    } catch {
        return null;
    }

    // A newer check owns the favicon box now
    if (run !== faviconRun) {
        return null;
    }
    if (!blob.type.startsWith("image/")) {
        return null;
    }

    faviconObjectUrl = URL.createObjectURL(blob);
    faviconActual.src = faviconObjectUrl;
    faviconDownload.href = faviconObjectUrl;
    faviconDownload.download = favicon.name;
    faviconDownload.textContent = `Download ${favicon.name}`;
    faviconBox.hidden = false;
    return blob;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function setPrStatus(text) {
    prStatusBox.textContent = text;
}

// Show PR box when the draft can be committed
function updatePrArea(view) {
    if (prBusy) {
        return;
    }
    markdownFallback.hidden = true;
    const usable = view.draft !== null && !view.originListed;
    if (usable) {
        const withIcon = view.existing ? "" : " (with the favicon)";
        prIntro.textContent =
            `If you open a pull request, the tool forks the data repo, commits this draft${withIcon}, ` +
            "and opens it from your GitHub account. " +
            "You can also open a prefilled GitHub issue with this report, or copy the markdown.";
    } else {
        prIntro.textContent = "Open a prefilled GitHub issue with this report, or copy the markdown.";
    }
    prButton.hidden = !usable;
    prButton.textContent = ghToken ? "Open pull request" : "Sign in with GitHub to open a PR";
    const nulls = usable && hasNull(view.draft);
    prButton.disabled = nulls;
    setPrStatus(nulls ? "The draft still has null fields; fill them in under Draft entry first." : "");
}

function beginSignIn() {
    const state = crypto.randomUUID();
    sessionStorage.setItem(
        "oauth-state",
        JSON.stringify({
            state,
            origin: originInput.value,
            destination: destinationInput.value,
            view: lastView,
            draftText: draftJson.value,
        })
    );
    const query = new URLSearchParams({
        client_id: OAUTH_CLIENT_ID,
        redirect_uri: location.origin + location.pathname,
        scope: "public_repo",
        state,
    });
    location.href = `https://github.com/login/oauth/authorize?${query}`;
}

function updateAccount() {
    if (ghToken) {
        accountText.textContent = ghUser ? `Signed in to GitHub as ${ghUser}.` : "Signed in to GitHub.";
        accountButton.textContent = "Sign out";
    } else {
        accountText.textContent = "Sign in with GitHub to open pull requests from this page.";
        accountButton.textContent = "Sign in with GitHub";
    }
}

// Drop GH token and revoke
async function signOut() {
    const token = ghToken;
    ghToken = null;
    ghUser = null;
    accountButton.disabled = true;
    updateAccount();
    if (lastView) {
        updatePrArea(lastView);
    }
    let revoked = false;
    try {
        const response = await fetch(OAUTH_REVOKE_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ access_token: token }),
        });
        revoked = response.ok;
    } catch {
        // Network failure, token stays valid
    }
    accountButton.disabled = false;
    if (!revoked) {
        setStatus(
            "Signed out, but GitHub did not confirm revoking the token. " +
                "You can revoke it on GitHub under Settings -> Applications -> Authorized OAuth Apps."
        );
    }
}

// Handle auth redirect back from GitHub
// ?code= on success
// ?error= if user cancelled
async function handleOAuthReturn() {
    const code = params.get("code");
    const denied = params.get("error");
    if (!code && !denied) {
        return;
    }
    const returnedState = params.get("state");
    history.replaceState(null, "", location.pathname);

    let saved = null;
    try {
        saved = JSON.parse(sessionStorage.getItem("oauth-state"));
    } catch {}
    sessionStorage.removeItem("oauth-state");
    if (!saved || !returnedState || saved.state !== returnedState) {
        setStatus("GitHub sign-in failed: this sign-in did not start in this tab. Try again.");
        return;
    }

    originInput.value = saved.origin;
    destinationInput.value = saved.destination;
    let failure = null;
    if (denied) {
        failure = params.get("error_description") || denied;
    }
    if (!failure) {
        try {
            setStatus("Finishing GitHub sign-in…");
            const response = await fetch(OAUTH_TOKEN_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ code }),
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok || !data.access_token) {
                throw new Error(data.error_description || data.error || `status ${response.status}`);
            }
            ghToken = data.access_token;
            try {
                const user = await gh("/user");
                ghUser = user.login;
            } catch {
                ghUser = null;
            }
        } catch (error) {
            failure = error.message || String(error);
        }
    }
    if (failure) {
        setStatus(`GitHub sign-in failed: ${failure}`);
    } else {
        setStatus("");
    }
    updateAccount();

    // Restore saved results even if sign-in failed
    if (saved.view) {
        lastView = saved.view;
        render(lastView);
        if (lastView.draft && typeof saved.draftText === "string") {
            draftJson.value = saved.draftText;
        }
        refreshMarkdown();
        faviconReady = loadFavicon(lastView.favicon);
        if (!failure && !prButton.hidden) {
            const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
            submitBox.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center" });
            prButton.focus({ preventScroll: true });
        }
    }
}

async function gh(path, { method = "GET", body, ok404 = false, raw = false } = {}) {
    const headers = {
        // Raw type reads file contents past JSON's 1 MB limit
        Accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
        Authorization: `Bearer ${ghToken}`,
    };
    const init = { method, headers, signal: AbortSignal.timeout(GITHUB_TIMEOUT) };
    if (body !== undefined) {
        headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(body);
    }
    const response = await fetch(`${GITHUB_API}${path}`, init);
    if (ok404 && response.status === 404) {
        return null;
    }
    if (raw) {
        if (!response.ok) {
            throw new Error(`GitHub returned ${response.status}`);
        }
        return response.text();
    }
    let data = null;
    if (response.status !== 204) {
        data = await response.json().catch(() => null);
    }
    if (!response.ok) {
        throw new Error(data?.message || `GitHub returned ${response.status}`);
    }
    return data;
}

function encodeBase64(bytes) {
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
}

// Insert new sorted entry or append origin to existing entry
function updatedSites(text, view) {
    const sites = JSON.parse(text);
    if (!Array.isArray(sites)) {
        throw new Error("the sites file did not parse as a list");
    }
    if (view.existing) {
        const target = sites.find((site) => site.id === view.existing.id);
        if (!target) {
            throw new Error(`entry ${view.existing.id} is gone from the data; re-run the check`);
        }
        const origin = view.draft;
        if (target.origins.some((o) => o.origin_base_url === origin.origin_base_url)) {
            throw new Error(`${origin.origin_base_url} is already listed; re-run the check`);
        }
        target.origins.push(origin);
    } else {
        if (sites.some((site) => site.id === view.entry.id)) {
            throw new Error(`entry id ${view.entry.id} is already taken; re-run the check`);
        }
        let index = sites.findIndex((site) => site.id > view.entry.id);
        if (index === -1) {
            index = sites.length;
        }
        sites.splice(index, 0, view.entry);
    }
    return JSON.stringify(sites, null, 2) + "\n";
}

// Wait until new fork answers (can take a few seconds)
async function forkReady(fork) {
    for (let attempt = 0; ; attempt++) {
        try {
            await gh(`/repos/${fork.full_name}/git/ref/heads/${fork.default_branch}`);
            return;
        } catch {
            if (attempt >= 14) {
                throw new Error("your fork is not ready yet; try again in a minute");
            }
            await sleep(2000);
        }
    }
}

async function buildCommitFiles(view, sitesText, icon) {
    const path = sitesFile(view.language);
    const notes = [];
    if (sitesText === null) {
        notes.push(
            `This is the first ${view.language} wiki, so this PR creates \`${path}\`. ` +
                "The extension needs code changes before it can use a new language."
        );
    }
    const sitesJson = new TextEncoder().encode(updatedSites(sitesText ?? "[]", view));
    const files = [{ path, content: encodeBase64(sitesJson) }];
    if (view.existing) {
        notes.push("The entry now lists more than one origin; update `origins_label` if it should name them all.");
    } else {
        const iconName = view.entry.destination_icon;
        if (typeof iconName === "string" && iconName) {
            if (!icon) {
                throw new Error(
                    `the favicon could not be fetched, and \`${iconName}\` must exist in the repo; open an issue instead`
                );
            }
            files.push({
                path: `favicons/${view.language}/${iconName}`,
                content: encodeBase64(new Uint8Array(await icon.arrayBuffer())),
            });
        }
    }
    let bodyNote = "";
    for (const note of notes) {
        bodyNote += `\n\n> ${note}`;
    }
    return { files, bodyNote };
}

function prTitle(view) {
    return view.existing
        ? `Add ${view.draft.origin} to ${view.existing.id}`
        : `Add ${view.entry.destination || view.entry.id}`;
}

async function createPullRequest() {
    const view = structuredClone(lastView);
    const iconReady = faviconReady;
    prBusy = true;
    prButton.disabled = true;
    accountButton.disabled = true;
    submit.disabled = true;
    prLink.hidden = true;
    try {
        setPrStatus("Preparing your fork of the data repo…");
        const fork = await gh(`/repos/${DATA_REPO}/forks`, { method: "POST", body: { default_branch_only: true } });
        const base = fork.parent.default_branch;
        const path = sitesFile(view.language);
        // sitesText is null for the first wiki in a language
        const [branchInfo, sitesText] = await Promise.all([
            gh(`/repos/${DATA_REPO}/branches/${base}`),
            gh(`/repos/${DATA_REPO}/contents/${path}?ref=${base}`, { raw: true, ok404: true }),
            forkReady(fork),
        ]);
        const head = branchInfo.commit;

        setPrStatus("Committing the draft…");
        const { files, bodyNote } = await buildCommitFiles(view, sitesText, await iconReady);
        const treeEntries = await Promise.all(
            files.map(async (file) => {
                const post = () =>
                    gh(`/repos/${fork.full_name}/git/blobs`, {
                        method: "POST",
                        body: { content: file.content, encoding: "base64" },
                    });
                let blob;
                try {
                    blob = await post();
                } catch {
                    await sleep(1000);
                    blob = await post();
                }
                return { path: file.path, mode: "100644", type: "blob", sha: blob.sha };
            })
        );
        const tree = await gh(`/repos/${fork.full_name}/git/trees`, {
            method: "POST",
            body: { base_tree: head.commit.tree.sha, tree: treeEntries },
        });
        const commit = await gh(`/repos/${fork.full_name}/git/commits`, {
            method: "POST",
            body: { message: prTitle(view), tree: tree.sha, parents: [head.sha] },
        });
        // Branch named w/ entry id, with iterating number if taken (-2, -3, etc.)
        const id = view.existing ? view.existing.id : view.entry.id;
        const slugId = id.replace(/[^A-Za-z0-9._-]/g, "-");
        let branch = slugId;
        for (let n = 2; ; n++) {
            const taken = await gh(`/repos/${fork.full_name}/git/ref/heads/${branch}`, { ok404: true });
            if (!taken) {
                break;
            }
            branch = `${slugId}-${n}`;
        }
        await gh(`/repos/${fork.full_name}/git/refs`, {
            method: "POST",
            body: { ref: `refs/heads/${branch}`, sha: commit.sha },
        });

        setPrStatus("Opening the pull request…");
        const pr = await gh(`/repos/${DATA_REPO}/pulls`, {
            method: "POST",
            body: {
                title: prTitle(view),
                head: `${fork.owner.login}:${branch}`,
                base,
                body: buildMarkdown(view, true) + bodyNote,
                maintainer_can_modify: true,
            },
        });

        setPrStatus(`Pull request #${pr.number} opened.`);
        prLink.href = pr.html_url;
        prLink.textContent = `View pull request #${pr.number}`;
        prLink.hidden = false;
        // Keep button off until an edit or new check turns it on
    } catch (error) {
        setPrStatus(`Could not open the pull request: ${error.message || error}`);
        prButton.disabled = false;
    } finally {
        prBusy = false;
        accountButton.disabled = false;
        submit.disabled = false;
    }
}

form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const originUrl = normalizeInputUrl(originInput.value);
    const destinationUrl = normalizeInputUrl(destinationInput.value);
    if (!originUrl || !destinationUrl) {
        setStatus("Both fields need a wiki URL.");
        return;
    }

    submit.disabled = true;
    results.hidden = true;
    try {
        setStatus("Checking both wikis…");
        const [origin, destination] = await Promise.all([profileWiki(originUrl), profileWiki(destinationUrl)]);

        let entry = null;
        let language = null;
        let dataResult = { warnings: [], existing: null, originListed: false };
        if (origin.baseUrl && destination.baseUrl) {
            language = origin.language || destination.language || "en";
            entry = buildEntry(origin, destination, language);
            setStatus("Checking against the Indie Wiki Buddy data…");
            dataResult = await checkAgainstData(entry, language);
        }

        lastView = buildView(origin, destination, entry, dataResult, language);
        render(lastView);
        refreshMarkdown();
        setStatus("");
        faviconReady = loadFavicon(lastView.favicon);
    } catch (error) {
        setStatus(`Something went wrong: ${error.message || error}`);
    } finally {
        submit.disabled = false;
    }
});

copyButton.addEventListener("click", async () => {
    if (!lastView) {
        return;
    }
    const text = buildMarkdown(lastView);
    let message = "Copied!";
    try {
        await navigator.clipboard.writeText(text);
        markdownFallback.hidden = true;
    } catch {
        message = "Copy failed";
        markdownFallback.value = text;
        markdownFallback.hidden = false;
        markdownFallback.select();
    }
    copyButton.textContent = message;
    setTimeout(() => {
        copyButton.textContent = "Copy markdown";
    }, 1500);
});

function showDraftError(text) {
    draftError.textContent = `⚠ ${text}`;
    prButton.disabled = true;
}

// Fields required by PR
function draftProblem(value, existing) {
    if (typeof value !== "object" || !value || Array.isArray(value)) {
        return "The draft must be a JSON object.";
    }
    // The first key whose value is not a non-empty string
    const missingText = (keys, obj) => keys.find((key) => typeof obj[key] !== "string" || !obj[key]);
    if (existing) {
        const key = missingText(["origin", "origin_base_url"], value);
        return key ? `The origin needs a text "${key}" field.` : null;
    }
    let key = missingText(["id", "origins_label", "destination", "destination_base_url"], value);
    if (key) {
        return `The entry needs a text "${key}" field.`;
    }
    if (!Array.isArray(value.origins) || !value.origins.length) {
        return 'The entry needs an "origins" list with at least one origin.';
    }
    for (const origin of value.origins) {
        if (typeof origin !== "object" || !origin || Array.isArray(origin)) {
            return "Each origin must be a JSON object.";
        }
        key = missingText(["origin", "origin_base_url"], origin);
        if (key) {
            return `Each origin needs a text "${key}" field.`;
        }
    }
    return null;
}

// Draft JSON edits into the markdown, issue link, and PR
draftJson.addEventListener("input", () => {
    if (!lastView?.draft) {
        return;
    }
    let value;
    try {
        value = JSON.parse(draftJson.value);
    } catch (error) {
        return showDraftError(`Not valid JSON: ${error.message}`);
    }
    const problem = draftProblem(value, lastView.existing);
    if (problem) {
        return showDraftError(problem);
    }
    draftError.textContent = "";
    lastView.draft = value;
    if (lastView.existing) {
        lastView.entry.origins[0] = value;
    } else {
        lastView.entry = value;
    }
    refreshMarkdown();
    updatePrArea(lastView);
});

prButton.addEventListener("click", () => {
    if (ghToken) {
        createPullRequest();
    } else {
        beginSignIn();
    }
});

accountButton.addEventListener("click", () => {
    if (ghToken) {
        signOut();
    } else {
        beginSignIn();
    }
});

updateAccount();
handleOAuthReturn();
