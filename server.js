import express from "express";
import * as cheerio from "cheerio";
import http from "node:http";
import https from "node:https";

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_LINK_CHECKS = 25;
const MAX_SOURCE_CHECKS = 8;
const TIMEOUT = 12000;

app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));

const STOP = new Set("a about above after again against all also amid an and any are as at be because been before being between both but by can could did do does down during each few for from further had has have having he her here hers herself him himself his how i if in into is it its itself just more most my myself no nor not now of off on once only or other our ours ourselves out over own same she should so some such than that the their theirs them themselves then there these they this those through to too under until up very was we were what when where which while who whom why will with you your yours yourself yourselves".split(" "));
const PROMO = ["game-changing", "revolutionary", "best ever", "must-have", "unbeatable", "guaranteed", "limited time", "act now", "exclusive offer", "risk-free", "unlock", "supercharge", "ultimate solution"];
const AI = ["in today's fast-paced", "delve into", "it is important to note", "it is worth noting", "in conclusion", "ever-evolving landscape", "game changer", "comprehensive guide", "seamlessly", "robust", "leverage", "moreover", "furthermore", "at the end of the day", "unlock the potential", "dive into"];
const MARKET = ["market", "sector", "industry", "macro", "inflation", "rates", "fed", "economy", "demand", "supply", "index"];
const TECHNICAL = ["support", "resistance", "breakout", "moving average", "rsi", "trendline", "technical", "level", "volume"];
const CATALYST = ["catalyst", "earnings", "guidance", "approval", "launch", "partnership", "upgrade", "downgrade", "report", "data"];
const RISK = ["risk", "downside", "bearish", "scenario", "unless", "threat", "headwind", "volatility", "loss"];
const TRUSTED = ["sec.gov", "federalreserve.gov", "treasury.gov", "bls.gov", "bea.gov", "census.gov", "ftc.gov", "cftc.gov", "imf.org", "worldbank.org", "bis.org", "oecd.org", "nasdaq.com", "nyse.com", "investor.gov", "bitcointreasuries.net", "bitcoin.org", "github.com"];
const SOCIAL = ["facebook.com", "twitter.com", "x.com", "linkedin.com", "pinterest.com", "whatsapp.com", "instagram.com", "youtube.com", "reddit.com", "t.me"];

app.post("/api/audit", async (req, res) => {
  try {
    const url = normalizeUrl(req.body?.url);
    if (!url) return res.status(400).json({ error: "Enter a valid article URL." });
    const html = await fetchHtml(url);
    const article = scrapeArticle(html, url);
    const keyword = clean(req.body?.focusKeyword || "") || inferKeyword(article.title, article.bodyText);
    const audit = await buildAudit(article, keyword);
    res.json(audit);
  } catch (error) {
    res.status(502).json({ error: error.message || "The article could not be audited." });
  }
});

app.listen(PORT, () => console.log(`Content Audit Tool running on port ${PORT}`));

function normalizeUrl(value) {
  if (!value || typeof value !== "string") return "";
  try {
    const url = new URL(value.trim().startsWith("http") ? value.trim() : `https://${value.trim()}`);
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : "";
  } catch {
    return "";
  }
}

async function fetchHtml(url) {
  try {
    return await fetchWithNodeClient(url, TIMEOUT);
  } catch {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT);
    try {
      const response = await fetch(url, { signal: controller.signal, headers: requestHeaders() });
      if (!response.ok) throw new Error(`The article returned HTTP ${response.status}.`);
      return await response.text();
    } finally {
      clearTimeout(timer);
    }
  }
}

function fetchWithNodeClient(url, timeout) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === "http:" ? http : https;
    const request = client.get(parsed, { family: 4, timeout, headers: requestHeaders() }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        resolve(fetchWithNodeClient(new URL(response.headers.location, url).toString(), timeout));
        return;
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        reject(new Error(`The URL returned HTTP ${response.statusCode}.`));
        return;
      }
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    request.on("timeout", () => request.destroy(new Error("The request timed out.")));
    request.on("error", reject);
  });
}

function requestHeaders() {
  return {
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.9",
    "user-agent": "Mozilla/5.0 ContentAuditTool/1.0"
  };
}

function scrapeArticle(html, pageUrl) {
  const $ = cheerio.load(html);
  $("script, style, noscript, svg, canvas, iframe, form, nav, footer, aside, header, .ad, .ads, .advertisement, [aria-hidden='true']").remove();
  const title = stripSite(firstText($, ["meta[property='og:title']", "meta[name='twitter:title']", "h1", "title"]));
  const author = cleanByline(firstText($, ["meta[name='author']", "meta[property='article:author']", "[rel='author']", ".author", ".byline", "[class*='author']", "[class*='byline']"]));
  const rawDate = firstText($, ["meta[property='article:published_time']", "meta[name='pubdate']", "meta[name='date']", "time[datetime]", "time", "[class*='date']", "[class*='published']"]);
  const category = firstText($, ["meta[property='article:section']", "meta[name='category']", "[class*='category'] a", "[class*='section'] a"]);
  const metaDescription = firstText($, ["meta[name='description']", "meta[property='og:description']", "meta[name='twitter:description']"]);
  const root = pickArticleRoot($);
  const paragraphs = root.find("p").map((_, el) => clean($(el).text())).get().filter((text) => text.length > 24 && !/^(sign up|subscribe|advertisement|related|share this|follow us)/i.test(text));
  const bodyText = clean(paragraphs.join(" ") || root.text());
  const h2Headings = root.find("h2").map((_, el) => clean($(el).text())).get().filter(Boolean);
  const links = dedupe(root.find("a[href]").map((_, el) => ({ text: clean($(el).text()), url: absoluteUrl($(el).attr("href"), pageUrl) })).get().filter((link) => link.url && !link.url.startsWith("mailto:") && !link.url.startsWith("tel:")), "url");
  const images = dedupe(root.find("img").map((_, el) => ({ alt: clean($(el).attr("alt") || ""), src: absoluteUrl($(el).attr("src") || $(el).attr("data-src"), pageUrl) })).get().filter((image) => image.src), "src");
  return { url: pageUrl, title, author, date: formatDate(rawDate), rawDate, category, metaDescription, paragraphs, bodyText, intro: paragraphs.slice(0, 2).join(" "), h2Headings, links, images, wordCount: words(bodyText).length };
}

function pickArticleRoot($) {
  let best = $("body");
  let bestScore = 0;
  ["article", "[role='article']", "main article", "main", ".article-content", ".entry-content", ".post-content", ".content", "#content"].forEach((selector) => {
    $(selector).each((_, el) => {
      const node = $(el);
      const score = words(node.find("p").map((__, p) => node.find(p).text()).get().join(" ")).length + node.find("h2").length * 20;
      if (score > bestScore) {
        best = node;
        bestScore = score;
      }
    });
  });
  return best;
}

function firstText($, selectors) {
  for (const selector of selectors) {
    const node = $(selector).first();
    const value = clean(node.attr("content") || node.attr("datetime") || node.text());
    if (value) return value;
  }
  return "";
}

async function buildAudit(article, keyword) {
  const stats = buildStats(article, keyword);
  const linkReport = await checkLinks(article.links.slice(0, MAX_LINK_CHECKS));
  const evidence = await verifyEvidence(article, stats);
  const gates = buildGates(article, stats, linkReport, evidence);
  const scoreDetails = buildScoreDetails(article, stats, linkReport, evidence);
  const scores = Object.fromEntries(Object.entries(scoreDetails).map(([name, section]) => [name, section.score]));
  const compositeScore = Math.round(avg(Object.values(scores)));
  return {
    article: {
      title: article.title || "Untitled article",
      url: article.url,
      author: article.author || "Not found",
      date: article.date || "Not found",
      category: article.category || "Not found",
      metaDescription: article.metaDescription || "",
      bodyPreview: article.bodyText ? `${article.bodyText.slice(0, 900)}${article.bodyText.length > 900 ? "..." : ""}` : "",
      wordCount: article.wordCount,
      h2Count: article.h2Headings.length,
      h2Headings: article.h2Headings,
      linksCount: article.links.length,
      imagesCount: article.images.length,
      links: article.links.slice(0, 12),
      images: article.images.slice(0, 8)
    },
    keyword: stats.keyword,
    keywordDensity: stats.keywordDensity,
    compositeScore,
    scores,
    scoreDetails,
    readability: stats.readability,
    credibility: evidence.summary,
    gates,
    editorNotes: editorNotes(article, stats, gates, scores, linkReport, evidence),
    suggestedFixes: suggestedFixes(article, stats, gates, evidence),
    linkReport
  };
}

function buildStats(article, keyword) {
  const bodyWords = words(article.bodyText);
  const sentences = splitSentences(article.bodyText);
  const keywordClean = clean(keyword).toLowerCase();
  const keywordHits = keywordClean ? countPhrase(article.bodyText, keywordClean) : 0;
  const passiveMatches = countPassive(sentences);
  const readability = { ...readabilityStats(sentences, bodyWords, article.paragraphs), passiveRatio: sentences.length ? round(passiveMatches / sentences.length * 100, 1) : 0, averageSentenceLength: sentences.length ? round(bodyWords.length / sentences.length, 1) : 0 };
  return {
    keyword: keywordClean,
    keywordHits,
    keywordDensity: bodyWords.length ? round(keywordHits / bodyWords.length * 100, 2) : 0,
    titleHasKeyword: hasPhrase(article.title, keywordClean),
    introHasKeyword: hasPhrase(article.intro, keywordClean),
    metaHasKeyword: hasPhrase(article.metaDescription, keywordClean),
    h2KeywordCount: keywordClean ? article.h2Headings.filter((heading) => hasPhrase(heading, keywordClean)).length : 0,
    sentenceCount: sentences.length,
    averageSentenceLength: readability.averageSentenceLength,
    readability,
    passiveRatio: readability.passiveRatio,
    promotionalMatches: findPhrases(article.bodyText, PROMO),
    aiPhraseMatches: findPhrases(article.bodyText, AI),
    numericClaims: numericClaims(article.bodyText),
    evidenceLinks: evidenceLinks(article.links, article.url),
    namedSourceLinks: evidenceLinks(article.links, article.url).filter((link) => link.text && !/^(showed|shows|source|report|data|chart|here|link)$/i.test(link.text)).length,
    marketContextHits: termHits(article.bodyText, MARKET),
    technicalLevelHits: termHits(article.bodyText, TECHNICAL),
    catalystHits: termHits(article.bodyText, CATALYST),
    riskHits: termHits(article.bodyText, RISK),
    priceTargets: priceTargets(article.title)
  };
}

function buildGates(article, stats, linkReport, evidence) {
  const broken = linkReport.checked.filter((link) => link.status === "fail").length;
  const uncertain = linkReport.checked.filter((link) => link.status === "warning").length;
  const depth = [stats.marketContextHits > 0, stats.technicalLevelHits > 0, stats.catalystHits > 0, stats.riskHits > 0];
  return [
    gate("Headline matches body promise", headlineMatch(article.title, article.bodyText) ? "pass" : "warning", headlineMatch(article.title, article.bodyText) ? "Core headline terms are reflected in the body." : "The body does not strongly reinforce the headline promise."),
    gate("Price targets in headline are supported in the body", stats.priceTargets.every((target) => article.bodyText.includes(target)) ? "pass" : "fail", stats.priceTargets.length ? `${stats.priceTargets.length} price target checks detected.` : "No headline price target was detected."),
    gate("Focus keyword appears in title, intro, meta description, and at least two H2s", stats.titleHasKeyword && stats.introHasKeyword && stats.metaHasKeyword && stats.h2KeywordCount >= 2 ? "pass" : "fail", `Keyword "${stats.keyword || "not detected"}" title: ${yes(stats.titleHasKeyword)}, intro: ${yes(stats.introHasKeyword)}, meta: ${yes(stats.metaHasKeyword)}, H2s: ${stats.h2KeywordCount}.`),
    gate("Article has 700-800 words", article.wordCount >= 700 && article.wordCount <= 800 ? "pass" : article.wordCount >= 600 && article.wordCount <= 900 ? "warning" : "fail", `Detected ${article.wordCount} words.`),
    gate("Article has 2-3 H2 headings", article.h2Headings.length >= 2 && article.h2Headings.length <= 3 ? "pass" : article.h2Headings.length >= 1 && article.h2Headings.length <= 4 ? "warning" : "fail", `Detected ${article.h2Headings.length} H2 headings.`),
    gate("Sentences average under 15 words", stats.averageSentenceLength > 0 && stats.averageSentenceLength < 15 ? "pass" : stats.averageSentenceLength <= 18 ? "warning" : "fail", `Average sentence length is ${stats.averageSentenceLength} words.`),
    gate("Readability formulas stay within newsroom range", stats.readability.fleschReadingEase >= 45 && stats.readability.fleschKincaidGrade <= 11 && stats.readability.gunningFog <= 12 ? "pass" : stats.readability.fleschReadingEase >= 35 && stats.readability.fleschKincaidGrade <= 14 ? "warning" : "fail", `Flesch ${stats.readability.fleschReadingEase}, grade ${stats.readability.fleschKincaidGrade}, Gunning Fog ${stats.readability.gunningFog}.`),
    gate("Long sentences stay below 20% of copy", stats.readability.longSentenceRatio <= 20 ? "pass" : stats.readability.longSentenceRatio <= 30 ? "warning" : "fail", `${stats.readability.longSentenceRatio}% of sentences are over 20 words.`),
    gate("No passive voice dominance", stats.passiveRatio <= 20 ? "pass" : stats.passiveRatio <= 30 ? "warning" : "fail", `Passive-pattern ratio is ${stats.passiveRatio}%.`),
    gate("No promotional language", stats.promotionalMatches.length === 0 ? "pass" : stats.promotionalMatches.length <= 2 ? "warning" : "fail", stats.promotionalMatches.length ? `Flagged: ${stats.promotionalMatches.join(", ")}.` : "No promotional phrases from the audit list were found."),
    gate("Sources are named and linked", stats.namedSourceLinks >= 2 ? "pass" : stats.namedSourceLinks === 1 ? "warning" : "fail", `${stats.namedSourceLinks} external named evidence links detected.`),
    gate("Source domains are diverse and credible", evidence.summary.sourceDomainDiversity >= 2 && evidence.summary.trustedSourceCount >= 1 ? "pass" : evidence.summary.sourceDomainDiversity >= 1 ? "warning" : "fail", `${evidence.summary.sourceDomainDiversity} source domains, ${evidence.summary.trustedSourceCount} high-authority sources.`),
    gate("Numeric claims are supported by linked evidence", evidence.summary.checkedClaims === 0 ? "warning" : evidence.summary.claimSupportRatio >= 70 ? "pass" : evidence.summary.claimSupportRatio >= 45 ? "warning" : "fail", evidence.summary.checkedClaims ? `${evidence.summary.supportedClaims}/${evidence.summary.checkedClaims} numeric claims matched fetched source pages.` : "No numeric claims could be checked against linked evidence pages."),
    gate("Broken links are checked", broken === 0 && uncertain === 0 ? "pass" : broken === 0 ? "warning" : "fail", `${linkReport.checked.length} links checked, ${broken} failed, ${uncertain} uncertain.`),
    gate("Meta description is present", article.metaDescription ? "pass" : "fail", article.metaDescription ? `${article.metaDescription.length} characters detected.` : "No meta description was found."),
    gate("Article includes market context, technical levels, catalyst, and risk scenario", depth.every(Boolean) ? "pass" : depth.filter(Boolean).length >= 2 ? "warning" : "fail", `Market: ${yes(depth[0])}, technical: ${yes(depth[1])}, catalyst: ${yes(depth[2])}, risk: ${yes(depth[3])}.`),
    gate("AI-sounding phrases are flagged", stats.aiPhraseMatches.length === 0 ? "pass" : stats.aiPhraseMatches.length <= 2 ? "warning" : "fail", stats.aiPhraseMatches.length ? `Flagged: ${stats.aiPhraseMatches.join(", ")}.` : "No AI-sounding phrases from the audit list were found.")
  ];
}

function buildScoreDetails(article, stats, linkReport, evidence) {
  const failed = linkReport.checked.filter((link) => link.status === "fail").length;
  const uncertain = linkReport.checked.filter((link) => link.status === "warning").length;
  const depthItems = [item("Market context", hitScore(stats.marketContextHits, 2), `${stats.marketContextHits} hits`), item("Technical levels", hitScore(stats.technicalLevelHits, 2), `${stats.technicalLevelHits} hits`, 1.1), item("Catalyst", hitScore(stats.catalystHits, 1), `${stats.catalystHits} hits`), item("Risk scenario", hitScore(stats.riskHits, 1), `${stats.riskHits} hits`), item("Evidence-backed numbers", evidence.summary.checkedClaims ? evidence.summary.claimSupportRatio : 45, `${evidence.summary.supportedClaims}/${evidence.summary.checkedClaims} claims`, 1.3)];
  const readItems = [item("Average sentence length", rangeScore(stats.averageSentenceLength, 10, 15, 6, 24), `${stats.averageSentenceLength} words`, 1.2), item("Flesch Reading Ease", rangeScore(stats.readability.fleschReadingEase, 50, 90, 20, 120), `${stats.readability.fleschReadingEase}`, 1.1), item("Flesch-Kincaid grade", rangeScore(stats.readability.fleschKincaidGrade, 7, 10.5, 4, 16), `${stats.readability.fleschKincaidGrade}`), item("Gunning Fog", rangeScore(stats.readability.gunningFog, 7, 12, 4, 18), `${stats.readability.gunningFog}`), item("Long sentence load", clamp(100 - stats.readability.longSentenceRatio * 3), `${stats.readability.longSentenceRatio}%`), item("Passive voice", clamp(100 - stats.passiveRatio * 3), `${stats.passiveRatio}%`, 0.9)];
  const seoItems = [item("Meta description", article.metaDescription ? 100 : 0, article.metaDescription ? `${article.metaDescription.length} chars` : "missing"), item("H2 structure", article.h2Headings.length >= 2 && article.h2Headings.length <= 3 ? 100 : article.h2Headings.length >= 1 && article.h2Headings.length <= 4 ? 70 : 25, `${article.h2Headings.length} H2s`), item("Keyword in title", stats.titleHasKeyword ? 100 : 35, yes(stats.titleHasKeyword)), item("Keyword in intro", stats.introHasKeyword ? 100 : 45, yes(stats.introHasKeyword)), item("Keyword in meta", stats.metaHasKeyword ? 100 : 30, yes(stats.metaHasKeyword)), item("Keyword in H2s", stats.h2KeywordCount >= 2 ? 100 : stats.h2KeywordCount === 1 ? 65 : 25, `${stats.h2KeywordCount} H2s`), item("Keyword density", stats.keywordDensity >= 0.25 && stats.keywordDensity <= 2.2 ? 100 : stats.keywordDensity > 0 ? 65 : 25, `${stats.keywordDensity}%`, 0.8)];
  const eeatItems = [item("Named author", article.author ? 100 : 35, article.author || "missing"), item("Publication date", article.date ? 95 : 40, article.date || "missing"), item("External evidence links", clamp(evidence.summary.evidenceLinks * 20), `${evidence.summary.evidenceLinks}`), item("Source diversity", clamp(evidence.summary.sourceDomainDiversity * 35), `${evidence.summary.sourceDomainDiversity}`), item("High-authority sources", clamp(evidence.summary.trustedSourceCount * 35), `${evidence.summary.trustedSourceCount}`), item("Numeric claim support", evidence.summary.checkedClaims ? evidence.summary.claimSupportRatio : 45, `${evidence.summary.supportedClaims}/${evidence.summary.checkedClaims}`, 1.3), item("Broken-link risk", linkReport.checked.length ? clamp(100 - failed * 35 - uncertain * 8) : 55, `${failed} failed, ${uncertain} uncertain`, 0.9)];
  const voiceItems = [item("AI phrase load", clamp(100 - stats.aiPhraseMatches.length * 20), `${stats.aiPhraseMatches.length}`), item("Promotional language", clamp(100 - stats.promotionalMatches.length * 25), `${stats.promotionalMatches.length}`), item("Sentence directness", rangeScore(stats.averageSentenceLength, 9, 15, 6, 21), `${stats.averageSentenceLength} words`, 0.9), item("Active construction", clamp(100 - stats.passiveRatio * 2.5), `${stats.passiveRatio}%`, 0.9), item("Paragraph rhythm", rangeScore(stats.readability.averageParagraphWords, 35, 85, 15, 140), `${stats.readability.averageParagraphWords} words`, 0.7)];
  const factualDepth = section(depthItems).score;
  const widthItems = [item("Target word count", article.wordCount >= 700 && article.wordCount <= 800 ? 100 : article.wordCount >= 600 && article.wordCount <= 900 ? 75 : article.wordCount >= 450 ? 55 : 25, `${article.wordCount} words`, 1.2), item("Heading coverage", article.h2Headings.length >= 2 && article.h2Headings.length <= 3 ? 100 : article.h2Headings.length >= 1 && article.h2Headings.length <= 4 ? 70 : 25, `${article.h2Headings.length} H2s`), item("Reporting dimensions", factualDepth, "context, levels, catalyst, risk, evidence", 1.2), item("Visual support", article.images.length ? 85 : 55, `${article.images.length} images`, 0.6)];
  return { "Factual Depth": section(depthItems), Readability: section(readItems), "SEO Structure": section(seoItems), "E-E-A-T": section(eeatItems), "Human Voice": section(voiceItems), "Content Width": section(widthItems) };
}

async function checkLinks(links) {
  const checked = await Promise.all(links.map(async (link) => ({ ...link, ...(await probe(link.url)) })));
  return { checked, totalLinks: links.length, limit: MAX_LINK_CHECKS };
}

async function probe(url) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const response = await fetch(url, { method: "HEAD", redirect: "follow", signal: controller.signal, headers: requestHeaders() });
    clearTimeout(timer);
    if (response.status >= 200 && response.status < 400) return { status: "pass", code: response.status, message: "Reachable." };
    if ([401, 403, 405, 429, 999].includes(response.status)) return { status: "warning", code: response.status, message: "Blocked or rate-limited during audit." };
    return { status: "fail", code: response.status, message: `Returned HTTP ${response.status}.` };
  } catch {
    return { status: "warning", code: null, message: "Could not verify during audit." };
  }
}

async function verifyEvidence(article, stats) {
  const links = stats.evidenceLinks.slice(0, MAX_SOURCE_CHECKS);
  const pages = (await Promise.all(links.map(fetchEvidencePage))).filter((page) => page.status === "fetched");
  const checked = pages.length ? stats.numericClaims.slice(0, 18).map((claim) => verifyClaim(claim, pages)) : [];
  const supported = checked.filter((claim) => claim.status === "supported").length;
  const domains = [...new Set(links.map((link) => host(link.url)).filter(Boolean))];
  const trusted = links.filter((link) => trustedHost(host(link.url))).length;
  const ratio = checked.length ? Math.round(supported / checked.length * 100) : 0;
  return { checkedClaims: checked, summary: { evidenceLinks: links.length, fetchedSources: pages.length, sourceDomainDiversity: domains.length, trustedSourceCount: trusted, numericClaims: stats.numericClaims.length, checkedClaims: checked.length, supportedClaims: supported, unsupportedClaims: checked.length - supported, claimSupportRatio: ratio, confidence: pages.length >= 2 && checked.length >= 5 && ratio >= 70 ? "high" : pages.length && checked.length >= 2 && ratio >= 45 ? "medium" : "low" } };
}

async function fetchEvidencePage(link) {
  try {
    const html = await fetchWithNodeClient(link.url, 8000);
    return { ...link, status: "fetched", host: host(link.url), text: normalizeEvidence(htmlToText(html)) };
  } catch {
    return { ...link, status: "unfetched", host: host(link.url), text: "" };
  }
}

function verifyClaim(claim, pages) {
  const page = pages.find((source) => claim.numberForms.some((form) => source.text.includes(form)) && claim.contextTerms.filter((term) => source.text.includes(term)).length >= Math.min(2, claim.contextTerms.length || 1));
  return { sentence: claim.sentence, numbers: claim.numbers, status: page ? "supported" : "unsupported", sourceUrl: page?.url || "", detail: page ? `Matched ${page.host}.` : "No fetched source contained the number and enough context." };
}

function editorNotes(article, stats, gates, scores, linkReport, evidence) {
  const fails = gates.filter((gate) => gate.status === "fail").length;
  const warns = gates.filter((gate) => gate.status === "warning").length;
  const strongest = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  const weakest = Object.entries(scores).sort((a, b) => a[1] - b[1])[0];
  const notes = [`${fails} fail gates and ${warns} warning gates require editor review.`, `Strongest section: ${strongest[0]} (${strongest[1]}).`, `Weakest section: ${weakest[0]} (${weakest[1]}).`];
  if (article.wordCount < 700) notes.push("The article is short for the 700-800 word target and needs more reporting or context.");
  if (stats.readability.fleschKincaidGrade > 11) notes.push(`Readability is heavy: grade ${stats.readability.fleschKincaidGrade}, Gunning Fog ${stats.readability.gunningFog}.`);
  if (evidence.summary.checkedClaims && evidence.summary.claimSupportRatio < 70) notes.push(`Only ${evidence.summary.supportedClaims}/${evidence.summary.checkedClaims} numeric claims matched linked evidence pages.`);
  if (linkReport.checked.some((link) => link.status === "fail")) notes.push("Repair or remove failed links before publishing.");
  return notes;
}

function suggestedFixes(article, stats, gates, evidence) {
  const fixes = [];
  if (!stats.titleHasKeyword || !stats.introHasKeyword || !stats.metaHasKeyword || stats.h2KeywordCount < 2) fixes.push(`Place "${stats.keyword}" in the title, intro, meta description, and at least two H2s.`);
  if (article.wordCount < 700) fixes.push("Add market context, technical levels, catalyst, and a risk paragraph to reach 700-800 words.");
  if (stats.readability.longSentenceRatio > 20) fixes.push("Split sentences over 20 words until long sentences are under 20% of the copy.");
  if (stats.readability.fleschKincaidGrade > 11) fixes.push("Lower the grade level by shortening clauses and replacing abstract wording with simple verbs.");
  if (stats.namedSourceLinks < 2) fixes.push("Name and link at least two external credible sources.");
  if (evidence.summary.sourceDomainDiversity < 2) fixes.push("Add evidence from at least two distinct external source domains.");
  if (evidence.summary.checkedClaims && evidence.summary.claimSupportRatio < 70) fixes.push("Attach source links for unsupported numeric claims or revise the numbers to match cited evidence.");
  if (!article.metaDescription) fixes.push("Write a concise meta description with the focus keyword.");
  if (stats.promotionalMatches.length) fixes.push("Replace promotional phrases with verifiable claims.");
  if (stats.aiPhraseMatches.length) fixes.push("Remove generic AI-like transitions and replace them with article-specific facts.");
  return fixes.length ? fixes : ["No major structural fixes are required. Do a final copy edit for precision and style."];
}

function readabilityStats(sentences, tokens, paragraphs) {
  const sentenceWords = sentences.map((sentence) => words(sentence).length).filter(Boolean);
  const paragraphWords = paragraphs.map((paragraph) => words(paragraph).length).filter(Boolean);
  const syllables = tokens.reduce((sum, word) => sum + syllableCount(word), 0);
  const complex = tokens.filter((word) => !/\d/.test(word) && syllableCount(word) >= 3).length;
  const sentenceCount = Math.max(sentenceWords.length, 1);
  const wordCount = Math.max(tokens.length, 1);
  const asl = wordCount / sentenceCount;
  const asw = syllables / wordCount;
  const flesch = 206.835 - 1.015 * asl - 84.6 * asw;
  const grade = 0.39 * asl + 11.8 * asw - 15.59;
  const fog = 0.4 * (asl + 100 * complex / wordCount);
  const long = sentenceWords.filter((count) => count > 20).length;
  return { fleschReadingEase: round(clamp(flesch, -20, 120), 1), fleschKincaidGrade: round(clamp(grade, 0, 20), 1), gunningFog: round(clamp(fog, 0, 25), 1), longSentenceCount: long, veryLongSentenceCount: sentenceWords.filter((count) => count > 30).length, longSentenceRatio: sentences.length ? round(long / sentences.length * 100, 1) : 0, complexWordRatio: round(complex / wordCount * 100, 1), paragraphCount: paragraphWords.length, averageParagraphWords: paragraphWords.length ? round(avg(paragraphWords), 1) : tokens.length, shortestSentenceWords: sentenceWords.length ? Math.min(...sentenceWords) : 0, longestSentenceWords: sentenceWords.length ? Math.max(...sentenceWords) : 0 };
}

function numericClaims(text) {
  return splitSentences(text).filter((sentence) => /\d/.test(sentence) && /(btc|bitcoin|usd|dollar|price|target|share|stock|million|billion|percent|%|held|sold|valued|debt|market|rank|no\.)/i.test(sentence)).slice(0, 18).map((sentence) => {
    const nums = (sentence.match(/[$£€]?\d+(?:,\d{3})*(?:\.\d+)?\s?(?:%|percent|btc|usd|dollars|million|billion|trillion|m|bn|k)?/gi) || []).map(clean).filter(Boolean);
    return { sentence: sentence.slice(0, 220), numbers: [...new Set(nums)], numberForms: [...new Set(nums.flatMap(numberForms))], contextTerms: words(sentence).filter((word) => word.length > 3 && !STOP.has(word) && !/^\d+$/.test(word)).slice(0, 10) };
  }).filter((claim) => claim.numbers.length);
}

function numberForms(value) {
  const base = normalizeEvidence(value);
  const digits = base.match(/\d+(?:\.\d+)?/g) || [];
  return [base, base.replaceAll(" ", ""), ...digits].filter((item) => item.length >= 2);
}

function evidenceLinks(links, articleUrl) {
  return dedupe(links.filter((link) => {
    if (!link.url || !link.text || !/^https?:/i.test(link.url)) return false;
    if (sameSite(link.url, articleUrl)) return false;
    const h = host(link.url);
    if (SOCIAL.some((domain) => h === domain || h.endsWith(`.${domain}`))) return false;
    if (/\/tag\/|\/category\/|\/author\/|privacy|terms|contact|about|advertis|share/i.test(link.url)) return false;
    return true;
  }), "url");
}

function splitSentences(text) {
  return clean(text).split(/(?<=[.!?])\s+/).map(clean).filter((sentence) => sentence.length > 5);
}

function words(text) {
  return (clean(text).toLowerCase().match(/[a-z0-9]+(?:['-][a-z0-9]+)?/g) || []);
}

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function findPhrases(text, phrases) {
  const lower = String(text || "").toLowerCase();
  return [...new Set(phrases.filter((phrase) => lower.includes(phrase)))];
}

function termHits(text, terms) {
  const lower = String(text || "").toLowerCase();
  return terms.reduce((sum, term) => sum + (lower.includes(term) ? 1 : 0), 0);
}

function countPhrase(text, phrase) {
  if (!phrase) return 0;
  return String(text || "").toLowerCase().split(phrase.toLowerCase()).length - 1;
}

function hasPhrase(text, phrase) {
  return Boolean(phrase && String(text || "").toLowerCase().includes(phrase.toLowerCase()));
}

function countPassive(sentences) {
  const be = new Set(["is", "are", "was", "were", "be", "been", "being"]);
  return sentences.filter((sentence) => {
    const tokens = words(sentence);
    return tokens.some((token, index) => be.has(token) && tokens[index + 1] && (tokens[index + 1].endsWith("ed") || tokens[index + 1].endsWith("en")));
  }).length;
}

function syllableCount(word) {
  const cleaned = word.toLowerCase().replace(/[^a-z]/g, "");
  if (cleaned.length <= 3) return 1;
  const groups = cleaned.replace(/e$/, "").match(/[aeiouy]+/g);
  return Math.max(groups ? groups.length : 1, 1);
}

function headlineMatch(title, body) {
  const bodySet = new Set(words(body));
  const important = words(title).filter((word) => word.length > 3 && !STOP.has(word));
  return important.length ? important.filter((word) => bodySet.has(word)).length / important.length >= 0.5 : false;
}

function inferKeyword(title, body) {
  const counts = new Map();
  [...words(title), ...words(title), ...words(body)].filter((word) => word.length > 3 && !STOP.has(word)).forEach((word) => counts.set(word, (counts.get(word) || 0) + 1));
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([word]) => word).join(" ");
}

function priceTargets(title) {
  return (title.match(/[$£€]\s?\d+(?:,\d{3})*(?:\.\d+)?|\b\d+(?:\.\d+)?\s?(?:usd|dollars|price target|target|%)/gi) || []).map(clean);
}

function htmlToText(html) {
  const $ = cheerio.load(html);
  $("script, style, noscript, svg, canvas, iframe, form").remove();
  return clean($("body").text() || $.root().text());
}

function normalizeEvidence(value) {
  return clean(value).toLowerCase().replace(/[,'’‘$£€]/g, " ").replace(/percent/g, "%");
}

function stripSite(title) {
  return clean(title).replace(/\s+[-|]\s+[^-|]+$/, "");
}

function cleanByline(author) {
  return clean(author).replace(/^by\s+/i, "").replace(/\s+\|\s+.+$/, "");
}

function formatDate(date) {
  const parsed = new Date(clean(date));
  return Number.isNaN(parsed.getTime()) ? clean(date) : parsed.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

function absoluteUrl(value, base) {
  try {
    return value ? new URL(value, base).toString() : "";
  } catch {
    return "";
  }
}

function dedupe(items, key) {
  const seen = new Set();
  return items.filter((item) => {
    const value = item[key];
    if (!value || seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function sameSite(url, base) {
  const a = host(url);
  const b = host(base);
  return a && b && (a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`));
}

function host(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

function trustedHost(h) {
  return TRUSTED.some((domain) => h === domain || h.endsWith(`.${domain}`)) || /\.(gov|edu)$/i.test(h);
}

function gate(name, status, detail) {
  return { name, status, detail };
}

function item(name, score, detail, weight = 1) {
  return { name, score: Math.round(clamp(score)), detail, weight };
}

function section(items) {
  const totalWeight = items.reduce((sum, item) => sum + item.weight, 0) || 1;
  return { score: Math.round(items.reduce((sum, item) => sum + item.score * item.weight, 0) / totalWeight), items };
}

function hitScore(hits, target) {
  return clamp(hits / target * 100);
}

function rangeScore(value, idealLow, idealHigh, min, max) {
  if (!value) return 0;
  if (value >= idealLow && value <= idealHigh) return 100;
  if (value < idealLow) return clamp((value - min) / (idealLow - min) * 100);
  return clamp((max - value) / (max - idealHigh) * 100);
}

function avg(values) {
  const nums = values.filter(Number.isFinite);
  return nums.length ? nums.reduce((sum, value) => sum + value, 0) / nums.length : 0;
}

function clamp(value, min = 0, max = 100) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : 0));
}

function round(value, places = 0) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function yes(value) {
  return value ? "yes" : "no";
}
