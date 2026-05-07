import express from "express";
import * as cheerio from "cheerio";
import http from "node:http";
import https from "node:https";

const app = express();
const PORT = process.env.PORT || 3000;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.4-mini";
const REQUEST_TIMEOUT = 12000;
const SOURCE_TIMEOUT = 8000;
const MAX_LINK_CHECKS = 25;
const MAX_SOURCE_CHECKS = 8;

app.use(express.json({ limit: "5mb" }));
app.use(express.static("public"));

const STOP = new Set("a about above after again against all also amid an and any are as at be because been before being between both but by can could did do does down during each few for from further had has have having he her here hers herself him himself his how i if in into is it its itself just more most my myself no nor not now of off on once only or other our ours ourselves out over own same she should so some such than that the their theirs them themselves then there these they this those through to too under until up very was we were what when where which while who whom why will with you your yours yourself yourselves".split(" "));
const PROMO = ["game-changing", "revolutionary", "best ever", "must-have", "unbeatable", "guaranteed", "limited time", "act now", "exclusive offer", "risk-free", "unlock", "supercharge", "transform your", "ultimate solution"];
const AI_PHRASES = ["in today's fast-paced", "delve into", "it is important to note", "it is worth noting", "in conclusion", "ever-evolving landscape", "game changer", "comprehensive guide", "seamlessly", "robust", "leverage", "moreover", "furthermore", "at the end of the day", "unlock the potential", "dive into"];
const MARKET = ["market", "sector", "industry", "macro", "inflation", "rates", "fed", "economy", "demand", "supply", "index"];
const TECHNICAL = ["support", "resistance", "breakout", "moving average", "rsi", "trendline", "technical", "level", "volume"];
const CATALYST = ["catalyst", "earnings", "guidance", "approval", "launch", "partnership", "upgrade", "downgrade", "report", "data", "filing", "flow", "inflow", "outflow"];
const RISK = ["risk", "downside", "bearish", "scenario", "unless", "threat", "headwind", "volatility", "loss", "uncertainty"];
const TRUSTED = ["sec.gov", "federalreserve.gov", "treasury.gov", "bls.gov", "bea.gov", "census.gov", "ftc.gov", "cftc.gov", "imf.org", "worldbank.org", "bis.org", "oecd.org", "nasdaq.com", "nyse.com", "investor.gov", "farside.co.uk", "sosovalue.com", "coinglass.com", "bitcointreasuries.net", "bitcoin.org", "github.com"];
const SOCIAL = ["facebook.com", "twitter.com", "x.com", "linkedin.com", "pinterest.com", "whatsapp.com", "instagram.com", "youtube.com", "reddit.com", "t.me", "telegram.me"];

app.post("/api/audit", async (req, res) => {
  try {
    const input = req.body || {};
    const article = await resolveArticleInput(input);
    const keyword = clean(input.focusKeyword || "") || inferKeyword(article.title, article.bodyText);
    const audit = await buildAudit(article, keyword, Boolean(input.enableAi));
    res.json(audit);
  } catch (error) {
    res.status(502).json({ error: error.message || "The article could not be audited." });
  }
});

app.listen(PORT, () => console.log(`Content Audit Tool running at http://localhost:${PORT}`));

async function resolveArticleInput(input) {
  const url = normalizeUrl(input.url || "");
  const content = String(input.content || "").trim();
  const metadata = {
    title: input.title || "",
    author: input.author || "",
    date: input.date || "",
    category: input.category || "",
    metaDescription: input.metaDescription || ""
  };

  if (countWords(content) >= 40) return articleFromContent(content, url || "Pasted content", metadata, input.evidenceUrls || "");
  if (!url) throw new Error("Enter a public article, Google Docs, Notion URL, or paste article content.");

  const html = await fetchReadableDocument(url);
  const article = scrapeArticle(html, url);
  article.links = mergeEvidenceLinks(article.links, input.evidenceUrls || "");
  return article;
}

async function fetchReadableDocument(url) {
  const docsUrl = googleDocsExportUrl(url);
  if (docsUrl) {
    try { return await fetchAnyText(docsUrl); }
    catch { throw new Error("The Google Docs link could not be read. Make it public or paste the article content."); }
  }
  return fetchHtml(url);
}

function googleDocsExportUrl(value) {
  try {
    const url = new URL(value);
    const match = url.pathname.match(/\/document\/d\/([^/]+)/);
    return url.hostname.includes("docs.google.com") && match ? `https://docs.google.com/document/d/${match[1]}/export?format=html` : "";
  } catch { return ""; }
}

async function fetchAnyText(url) {
  try { return await fetchWithNodeClient(url, { allowAnyContentType: true, timeout: REQUEST_TIMEOUT }); }
  catch {
    const response = await fetch(url, { headers: requestHeaders() });
    if (!response.ok) throw new Error(`The document returned HTTP ${response.status}.`);
    return response.text();
  }
}

function articleFromContent(content, fallbackUrl, metadata = {}, evidenceUrls = "") {
  const raw = String(content || "").trim();
  const htmlLike = /<\/?(h1|h2|p|article|div|a|img|strong|em)\b/i.test(raw);
  const parsed = htmlLike ? parseHtmlContent(raw, fallbackUrl) : parsePlainContent(raw, fallbackUrl);
  const title = clean(metadata.title) || parsed.title || inferTitle(raw) || "Pasted article draft";
  const bodyText = parsed.bodyText;
  return {
    url: fallbackUrl || "Pasted content",
    title,
    author: cleanByline(metadata.author || ""),
    date: formatDate(metadata.date || ""),
    rawDate: metadata.date || "",
    category: clean(metadata.category || ""),
    metaDescription: clean(metadata.metaDescription || ""),
    paragraphs: parsed.paragraphs,
    bodyText,
    intro: parsed.paragraphs.slice(0, 2).join(" ") || bodyText.slice(0, 500),
    h2Headings: parsed.h2Headings,
    links: mergeEvidenceLinks(parsed.links, evidenceUrls),
    images: parsed.images,
    wordCount: countWords(bodyText)
  };
}

function parseHtmlContent(html, fallbackUrl) {
  const $ = cheerio.load(html);
  $("script, style, noscript, svg, canvas, iframe, form").remove();
  const title = firstText($, ["h1", "title"]);
  const paragraphs = $("p").map((_, el) => clean($(el).text())).get().filter(isUsefulText);
  const bodyText = clean(paragraphs.join(" ") || $("body").text() || $.root().text());
  const h2Headings = $("h2").map((_, el) => clean($(el).text())).get().filter(Boolean);
  const links = $("a[href]").map((_, el) => ({ text: clean($(el).text()) || clean($(el).attr("href")), url: absoluteUrl($(el).attr("href"), fallbackUrl) })).get().filter((link) => link.url);
  const images = $("img").map((_, el) => ({ alt: clean($(el).attr("alt") || ""), src: absoluteUrl($(el).attr("src") || $(el).attr("data-src"), fallbackUrl) })).get().filter((image) => image.src);
  return { title, paragraphs: paragraphs.length ? paragraphs : splitParagraphs(bodyText), bodyText, h2Headings, links: dedupe(links, "url"), images: dedupe(images, "src") };
}

function parsePlainContent(content, fallbackUrl) {
  const lines = String(content || "").split(/\r?\n/).map((line) => line.trim());
  const titleLine = lines.find((line) => /^#\s+/.test(line)) || "";
  const h2Headings = lines.filter((line) => /^##\s+/.test(line)).map((line) => line.replace(/^##\s+/, "").trim()).filter(Boolean);
  const bodyContent = lines.filter((line) => !/^#{1,6}\s+/.test(line)).join("\n");
  const paragraphs = splitParagraphs(bodyContent).map(stripMarkdown).filter((paragraph) => paragraph.length > 12);
  const bodyText = clean(stripMarkdown(bodyContent) || paragraphs.join(" "));
  return { title: titleLine.replace(/^#\s+/, "").trim(), paragraphs, bodyText, h2Headings, links: markdownLinks(content, fallbackUrl), images: markdownImages(content, fallbackUrl) };
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
  const paragraphs = root.find("p").map((_, el) => clean($(el).text())).get().filter(isUsefulText);
  const bodyText = clean(paragraphs.join(" ") || root.text());
  const h2Headings = root.find("h2").map((_, el) => clean($(el).text())).get().filter(Boolean);
  const links = root.find("a[href]").map((_, el) => ({ text: clean($(el).text()), url: absoluteUrl($(el).attr("href"), pageUrl) })).get().filter((link) => link.url && !link.url.startsWith("mailto:") && !link.url.startsWith("tel:"));
  const images = root.find("img").map((_, el) => ({ alt: clean($(el).attr("alt") || ""), src: absoluteUrl($(el).attr("src") || $(el).attr("data-src"), pageUrl) })).get().filter((image) => image.src);
  return { url: pageUrl, title, author, date: formatDate(rawDate), rawDate, category, metaDescription, paragraphs, bodyText, intro: paragraphs.slice(0, 2).join(" "), h2Headings, links: dedupe(links, "url"), images: dedupe(images, "src"), wordCount: countWords(bodyText) };
}

function pickArticleRoot($) {
  let best = $("body");
  let bestScore = 0;
  ["article", "[role='article']", "main article", "main", ".article-content", ".entry-content", ".post-content", ".content", "#content"].forEach((selector) => {
    $(selector).each((_, el) => {
      const node = $(el);
      const score = countWords(node.find("p").map((__, p) => $(p).text()).get().join(" ")) + node.find("h2").length * 20;
      if (score > bestScore) { best = node; bestScore = score; }
    });
  });
  return best;
}

async function buildAudit(article, keyword, enableAi) {
  const stats = buildStats(article, keyword);
  const linkReport = await checkLinks(article.links.slice(0, MAX_LINK_CHECKS));
  const evidenceReport = await verifyEvidence(article, stats);
  const extractionQuality = assessExtraction(article);
  const gates = [gate("Article body extraction is sufficient", extractionQuality.status, extractionQuality.detail), ...buildGates(article, stats, linkReport, evidenceReport)];
  const scoreDetails = capScores(buildScoreDetails(article, stats, linkReport, evidenceReport), extractionQuality);
  const scores = Object.fromEntries(Object.entries(scoreDetails).map(([name, section]) => [name, section.score]));
  const baseScore = Math.round(avg(Object.values(scores)));
  const compositeScore = Math.min(baseScore, extractionQuality.scoreCap);
  const aiReview = await buildAiReview(article, stats, gates, evidenceReport, enableAi);
  const editorialIntelligence = buildEditorialIntelligence(article, stats, gates, linkReport, evidenceReport, aiReview);
  return {
    article: {
      title: article.title || "Untitled article",
      url: article.url,
      author: article.author || "Not found",
      date: article.date || "Not found",
      category: article.category || "Not found",
      metaDescription: article.metaDescription || "",
      bodyPreview: article.bodyText ? `${article.bodyText.slice(0, 900)}${article.bodyText.length > 900 ? "..." : ""}` : "",
      paragraphs: buildContextMap(article),
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
    extractionQuality,
    compositeScore,
    scores,
    scoreDetails,
    readability: stats.readability,
    credibility: evidenceReport.summary,
    evidenceReview: { unsupportedClaims: evidenceReport.unsupportedClaims, checkedClaims: evidenceReport.checkedClaims.slice(0, 12), sourceFetches: evidenceReport.sourceFetches.slice(0, 8) },
    editorialIntelligence,
    aiReview,
    aiEditorialScore: aiReview.editorial_score ?? null,
    aiAdjustedComposite: aiReview.editorial_score ? Math.round(compositeScore * 0.85 + aiReview.editorial_score * 0.15) : null,
    gates,
    editorNotes: editorNotes(article, stats, gates, scores, linkReport, evidenceReport, extractionQuality, aiReview),
    suggestedFixes: suggestedFixes(article, stats, gates, evidenceReport),
    linkReport
  };
}

function buildStats(article, keyword) {
  const bodyText = article.bodyText || "";
  const sentences = splitSentences(bodyText);
  const tokens = words(bodyText);
  const keywordClean = clean(keyword).toLowerCase();
  const keywordHits = keywordClean ? countPhrase(bodyText, keywordClean) : 0;
  const readability = readabilityStats(sentences, tokens, article.paragraphs || []);
  const passiveRatio = sentences.length ? round(countPassive(sentences) / sentences.length * 100, 1) : 0;
  const sentenceProfile = profileSentences(sentences);
  return {
    keyword: keywordClean,
    keywordHits,
    keywordDensity: tokens.length ? round(keywordHits / tokens.length * 100, 2) : 0,
    titleHasKeyword: hasPhrase(article.title, keywordClean),
    introHasKeyword: hasPhrase(article.intro || bodyText.slice(0, 500), keywordClean),
    metaHasKeyword: hasPhrase(article.metaDescription, keywordClean),
    h2KeywordCount: keywordClean ? article.h2Headings.filter((heading) => hasPhrase(heading, keywordClean)).length : 0,
    sentenceCount: sentences.length,
    averageSentenceLength: sentences.length ? round(tokens.length / sentences.length, 1) : 0,
    readability: { ...readability, passiveRatio, averageSentenceLength: sentences.length ? round(tokens.length / sentences.length, 1) : 0 },
    passiveRatio,
    promotionalMatches: findPhrases(bodyText, PROMO),
    aiPhraseMatches: findPhrases(bodyText, AI_PHRASES),
    numericClaims: numericClaims(bodyText),
    evidenceLinks: evidenceLinks(article.links, article.url),
    namedSourceLinks: evidenceLinks(article.links, article.url).filter((link) => link.text && !/^(showed|shows|source|report|data|chart|here|link)$/i.test(link.text)).length,
    marketContextHits: termHits(bodyText, MARKET),
    technicalLevelHits: termHits(bodyText, TECHNICAL),
    catalystHits: termHits(bodyText, CATALYST),
    riskHits: termHits(bodyText, RISK),
    priceTargets: priceTargets(article.title),
    longSentences: sentenceProfile.longSentences,
    repetitiveOpenings: sentenceProfile.repetitiveOpenings
  };
}

function assessExtraction(article) {
  const paragraphs = (article.paragraphs || []).filter((paragraph) => countWords(paragraph) >= 8);
  const wordCount = article.wordCount || 0;
  const hasPreview = clean(article.bodyText).length >= 160;
  if (!hasPreview || wordCount < 40 || paragraphs.length === 0) return { status: "fail", label: "Failed", scoreCap: 20, detail: `Only ${wordCount} words and ${paragraphs.length} usable paragraphs were extracted. The audit is not reliable until article text is loaded.` };
  if (wordCount < 150) return { status: "fail", label: "Very thin", scoreCap: 35, detail: `Only ${wordCount} words were extracted. This looks like a partial scrape or blocked article body.` };
  if (wordCount < 350 || paragraphs.length < 2) return { status: "warning", label: "Partial", scoreCap: 55, detail: `${wordCount} words and ${paragraphs.length} usable paragraphs were extracted. Treat scores as partial until the full article is loaded or pasted.` };
  return { status: "pass", label: "Loaded", scoreCap: 100, detail: `${wordCount} words and ${paragraphs.length} usable paragraphs were extracted.` };
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
  const depthItems = [scoreItem("Market context", hitScore(stats.marketContextHits, 2), `${stats.marketContextHits} hits`), scoreItem("Technical levels", hitScore(stats.technicalLevelHits, 2), `${stats.technicalLevelHits} hits`, 1.1), scoreItem("Catalyst", hitScore(stats.catalystHits, 1), `${stats.catalystHits} hits`), scoreItem("Risk scenario", hitScore(stats.riskHits, 1), `${stats.riskHits} hits`), scoreItem("Evidence-backed numbers", evidence.summary.checkedClaims ? evidence.summary.claimSupportRatio : 45, `${evidence.summary.supportedClaims}/${evidence.summary.checkedClaims} claims`, 1.3)];
  const readItems = [scoreItem("Average sentence length", rangeScore(stats.averageSentenceLength, 10, 15, 6, 24), `${stats.averageSentenceLength} words`, 1.2), scoreItem("Flesch Reading Ease", rangeScore(stats.readability.fleschReadingEase, 50, 90, 20, 120), `${stats.readability.fleschReadingEase}`, 1.1), scoreItem("Flesch-Kincaid grade", rangeScore(stats.readability.fleschKincaidGrade, 7, 10.5, 4, 16), `${stats.readability.fleschKincaidGrade}`), scoreItem("Gunning Fog", rangeScore(stats.readability.gunningFog, 7, 12, 4, 18), `${stats.readability.gunningFog}`), scoreItem("Long sentence load", clamp(100 - stats.readability.longSentenceRatio * 3), `${stats.readability.longSentenceRatio}%`), scoreItem("Passive voice", clamp(100 - stats.passiveRatio * 3), `${stats.passiveRatio}%`, 0.9)];
  const seoItems = [scoreItem("Meta description", article.metaDescription ? 100 : 0, article.metaDescription ? `${article.metaDescription.length} chars` : "missing"), scoreItem("H2 structure", article.h2Headings.length >= 2 && article.h2Headings.length <= 3 ? 100 : article.h2Headings.length >= 1 && article.h2Headings.length <= 4 ? 70 : 25, `${article.h2Headings.length} H2s`), scoreItem("Keyword in title", stats.titleHasKeyword ? 100 : 35, yes(stats.titleHasKeyword)), scoreItem("Keyword in intro", stats.introHasKeyword ? 100 : 45, yes(stats.introHasKeyword)), scoreItem("Keyword in meta", stats.metaHasKeyword ? 100 : 30, yes(stats.metaHasKeyword)), scoreItem("Keyword in H2s", stats.h2KeywordCount >= 2 ? 100 : stats.h2KeywordCount === 1 ? 65 : 25, `${stats.h2KeywordCount} H2s`), scoreItem("Keyword density", stats.keywordDensity >= 0.25 && stats.keywordDensity <= 2.2 ? 100 : stats.keywordDensity > 0 ? 65 : 25, `${stats.keywordDensity}%`, 0.8)];
  const eeatItems = [scoreItem("Named author", article.author ? 100 : 35, article.author || "missing"), scoreItem("Publication date", article.date ? 95 : 40, article.date || "missing"), scoreItem("External evidence links", clamp(evidence.summary.evidenceLinks * 20), `${evidence.summary.evidenceLinks}`), scoreItem("Source diversity", clamp(evidence.summary.sourceDomainDiversity * 35), `${evidence.summary.sourceDomainDiversity}`), scoreItem("High-authority sources", clamp(evidence.summary.trustedSourceCount * 35), `${evidence.summary.trustedSourceCount}`), scoreItem("Numeric claim support", evidence.summary.checkedClaims ? evidence.summary.claimSupportRatio : 45, `${evidence.summary.supportedClaims}/${evidence.summary.checkedClaims}`, 1.3), scoreItem("Broken-link risk", linkReport.checked.length ? clamp(100 - failed * 35 - uncertain * 8) : 55, `${failed} failed, ${uncertain} uncertain`, 0.9)];
  const voiceItems = [scoreItem("AI-style phrase load", clamp(100 - stats.aiPhraseMatches.length * 20), `${stats.aiPhraseMatches.length}`), scoreItem("Promotional language", clamp(100 - stats.promotionalMatches.length * 25), `${stats.promotionalMatches.length}`), scoreItem("Sentence directness", rangeScore(stats.averageSentenceLength, 9, 15, 6, 21), `${stats.averageSentenceLength} words`, 0.9), scoreItem("Active construction", clamp(100 - stats.passiveRatio * 2.5), `${stats.passiveRatio}%`, 0.9), scoreItem("Paragraph rhythm", rangeScore(stats.readability.averageParagraphWords, 35, 85, 15, 140), `${stats.readability.averageParagraphWords} words`, 0.7)];
  const factualDepth = section(depthItems).score;
  const widthItems = [scoreItem("Target word count", article.wordCount >= 700 && article.wordCount <= 800 ? 100 : article.wordCount >= 600 && article.wordCount <= 900 ? 75 : article.wordCount >= 450 ? 55 : 25, `${article.wordCount} words`, 1.2), scoreItem("Heading coverage", article.h2Headings.length >= 2 && article.h2Headings.length <= 3 ? 100 : article.h2Headings.length >= 1 && article.h2Headings.length <= 4 ? 70 : 25, `${article.h2Headings.length} H2s`), scoreItem("Reporting dimensions", factualDepth, "context, levels, catalyst, risk, evidence", 1.2), scoreItem("Visual support", article.images.length ? 85 : 55, `${article.images.length} images`, 0.6)];
  return { "Factual Depth": section(depthItems), Readability: section(readItems), "SEO Structure": section(seoItems), "E-E-A-T": section(eeatItems), "Human Voice": section(voiceItems), "Content Width": section(widthItems) };
}

function capScores(scoreDetails, extraction) {
  if (!extraction || extraction.scoreCap >= 100) return scoreDetails;
  return Object.fromEntries(Object.entries(scoreDetails).map(([name, detail]) => [name, { ...detail, score: Math.min(detail.score, extraction.scoreCap), items: [...detail.items, scoreItem("Extraction confidence", extraction.scoreCap, extraction.detail, 1.5)] }]));
}

async function buildAiReview(article, stats, gates, evidence, enableAi) {
  if (!enableAi) return { enabled: false, status: "disabled", model: OPENAI_MODEL, message: "Editorial intelligence review was not requested." };
  if (!process.env.OPENAI_API_KEY) return { enabled: true, status: "not_configured", model: OPENAI_MODEL, message: "Set OPENAI_API_KEY on the server to enable editorial intelligence review." };
  try {
    const response = await fetch(`${process.env.OPENAI_BASE_URL || "https://api.openai.com/v1"}/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        input: [{ role: "system", content: "You are a senior crypto newsroom standards editor. Return diagnostic flags only. Do not write replacement copy." }, { role: "user", content: JSON.stringify({ title: article.title, url: article.url, wordCount: article.wordCount, keyword: stats.keyword, gates, evidence: evidence.summary, excerpt: article.bodyText.slice(0, 10000) }) }],
        text: { format: { type: "json_schema", name: "editorial_flags", strict: true, schema: aiSchema() } },
        max_output_tokens: 1800
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || `OpenAI API returned HTTP ${response.status}.`);
    const parsed = JSON.parse(responseText(data));
    return { enabled: true, status: "ok", model: OPENAI_MODEL, message: "Editorial intelligence review completed.", editorial_flags: (parsed.editorial_flags || []).slice(0, 12), summary_notes: (parsed.summary_notes || []).slice(0, 6), editorial_score: clamp(Number(parsed.editorial_score) || 0) };
  } catch (error) {
    return { enabled: true, status: "error", model: OPENAI_MODEL, message: error.message || "Editorial intelligence review failed." };
  }
}

function aiSchema() {
  return { type: "object", additionalProperties: false, required: ["editorial_score", "editorial_flags", "summary_notes"], properties: { editorial_score: { type: "integer", minimum: 0, maximum: 100 }, editorial_flags: { type: "array", maxItems: 12, items: { type: "object", additionalProperties: false, required: ["category", "flagged_text", "issue", "location", "severity", "credibility_impact", "newsroom_recommendation"], properties: { category: { type: "string", enum: ["fluency", "fact_validation", "editorial_risk", "source_intelligence", "narrative_diagnostics", "headline_alignment"] }, flagged_text: { type: "string" }, issue: { type: "string" }, location: { type: "string" }, severity: { type: "string", enum: ["low", "medium", "high"] }, credibility_impact: { type: "string" }, newsroom_recommendation: { type: "string" } } } }, summary_notes: { type: "array", maxItems: 6, items: { type: "string" } } } };
}

function responseText(response) {
  if (response.output_text) return response.output_text;
  const text = (response.output || []).flatMap((item) => item.content || []).map((content) => content.text || content.output_text || "").join("");
  if (!text) throw new Error("OpenAI response did not include parseable text.");
  return text;
}

function buildEditorialIntelligence(article, stats, gates, linkReport, evidence, aiReview) {
  const flags = [];
  if (aiReview?.status === "ok") flags.push(...(aiReview.editorial_flags || []).map((flag) => normalizeFlag(flag)));
  for (const term of stats.promotionalMatches.slice(0, 4)) flags.push(flag("editorial_risk", term, "Potential promotional or unsupported certainty language.", findLocation(article, term), term === "guaranteed" || term === "risk-free" ? "high" : "medium", "Medium editorial and reputation risk.", "Verify whether the wording is supported by evidence before publishing.", "Rules audit"));
  for (const phrase of stats.aiPhraseMatches.slice(0, 4)) flags.push(flag("fluency", phrase, "Generic AI-style or formulaic phrase pattern detected.", findLocation(article, phrase), "low", "Low human-voice and reader-trust risk.", "Check whether this phrase adds article-specific reporting value.", "Rules audit"));
  for (const item of stats.longSentences.slice(0, 4)) flags.push(flag("fluency", `Long sentence detected (${item.words} words)`, item.sentence, findLocation(article, item.sentence), item.words >= 35 ? "medium" : "low", item.words >= 35 ? "Medium readability quality risk." : "Low readability quality risk.", "Review for pacing, claim density, and reader comprehension.", "Readability audit"));
  for (const opening of stats.repetitiveOpenings.slice(0, 3)) flags.push(flag("narrative_diagnostics", `${opening.count} sentences begin with "${opening.opening}"`, "Repetitive sentence opening rhythm detected.", `Sentences ${opening.examples.map((example) => example.index).join(", ")}`, "low", "Low fluency and editorial polish risk.", "Review sentence rhythm and vary structure where repetition weakens flow.", "Readability audit"));
  for (const claim of evidence.unsupportedClaims.slice(0, 5)) flags.push(flag("fact_validation", claim.sentence || claim.numbers.join(", "), "Numeric claim was not matched against fetched evidence-source pages.", findLocation(article, claim.sentence), "high", "High factual and credibility risk.", "Check the number against linked evidence or add a primary data source.", "Evidence audit"));
  const headlineGate = gates.find((gate) => gate.name === "Headline matches body promise" && gate.status !== "pass");
  if (headlineGate) flags.push(flag("headline_alignment", article.title, headlineGate.detail, "Headline", "medium", "Medium headline/body alignment risk.", "Verify the headline promise is clearly supported in the body.", "Rules audit"));
  if (evidence.summary.evidenceLinks < 2 || evidence.summary.trustedSourceCount < 1) flags.push(flag("source_intelligence", `${evidence.summary.evidenceLinks} evidence links, ${evidence.summary.trustedSourceCount} high-authority sources`, "Source depth is weak for a credibility-sensitive crypto article.", "Sources", evidence.summary.evidenceLinks === 0 ? "high" : "medium", evidence.summary.evidenceLinks === 0 ? "High credibility risk." : "Medium credibility risk.", "Add named, linked primary or high-authority sources for market data, filings, ETF flow, liquidation, or derivatives claims.", "Source audit"));
  for (const link of linkReport.checked.filter((item) => item.status === "fail").slice(0, 3)) flags.push(flag("source_intelligence", link.url, link.message || "Linked source failed verification.", "Source links", "high", "High sourcing and publication-readiness risk.", "Repair the link or replace it with a reachable source before publishing.", "Link audit"));
  return { status: aiReview?.status || "rules_only", model: aiReview?.model || null, flags: dedupeFlags(flags).sort((a, b) => severityWeight(b.severity) - severityWeight(a.severity)).slice(0, 16) };
}

function normalizeFlag(value = {}) { return flag(value.category, value.flagged_text || value.flag, value.issue, value.location, value.severity, value.credibility_impact || value.credibilityImpact, value.newsroom_recommendation || value.recommendation, "Editorial intelligence"); }
function flag(category, flaggedText, issue, location, severity, impact, recommendation, source) { return { category: normalizeCategory(category), flag: truncate(flaggedText || "Contextual issue", 220), issue: truncate(issue || "Editorial issue detected.", 320), location: clean(location || "Article body"), severity: normalizeSeverity(severity), credibilityImpact: clean(impact || `${capitalize(normalizeSeverity(severity))} newsroom risk.`), recommendation: truncate(recommendation || "Review this issue before publication.", 320), source: source || "Rules audit" }; }
function normalizeCategory(value) { const normalized = clean(value).toLowerCase().replace(/[\s-]+/g, "_"); return ["fluency", "fact_validation", "editorial_risk", "source_intelligence", "narrative_diagnostics", "headline_alignment"].includes(normalized) ? normalized : "editorial_risk"; }
function normalizeSeverity(value) { const normalized = clean(value).toLowerCase(); return ["low", "medium", "high"].includes(normalized) ? normalized : "medium"; }
function severityWeight(value) { return { low: 1, medium: 2, high: 3 }[value] || 0; }
function dedupeFlags(flags) { const seen = new Set(); return flags.filter((item) => { const key = `${item.category}|${item.flag}|${item.issue}`.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; }); }

async function checkLinks(links) { const checked = await Promise.all(links.map(async (link) => ({ ...link, ...(await probe(link.url)) }))); return { checked, totalLinks: links.length, limit: MAX_LINK_CHECKS }; }
async function probe(url) { try { const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 6000); const response = await fetch(url, { method: "HEAD", redirect: "follow", signal: controller.signal, headers: requestHeaders() }); clearTimeout(timer); if (response.status >= 200 && response.status < 400) return { status: "pass", code: response.status, message: "Reachable." }; if ([401, 403, 405, 429, 999].includes(response.status)) return { status: "warning", code: response.status, message: "Blocked or rate-limited during audit." }; return { status: "fail", code: response.status, message: `Returned HTTP ${response.status}.` }; } catch { return { status: "warning", code: null, message: "Could not verify during audit." }; } }

async function verifyEvidence(article, stats) {
  const links = stats.evidenceLinks.slice(0, MAX_SOURCE_CHECKS);
  const sourceFetches = await Promise.all(links.map(fetchEvidencePage));
  const pages = sourceFetches.filter((page) => page.status === "fetched");
  const checkedClaims = pages.length ? stats.numericClaims.slice(0, 18).map((claim) => verifyClaim(claim, pages)) : [];
  const supportedClaims = checkedClaims.filter((claim) => claim.status === "supported").length;
  const domains = [...new Set(links.map((link) => host(link.url)).filter(Boolean))];
  const trustedSourceCount = links.filter((link) => trustedHost(host(link.url))).length;
  const claimSupportRatio = checkedClaims.length ? Math.round(supportedClaims / checkedClaims.length * 100) : 0;
  return { sourceFetches: sourceFetches.map(({ text, ...rest }) => rest), checkedClaims, unsupportedClaims: checkedClaims.filter((claim) => claim.status !== "supported").slice(0, 8), summary: { evidenceLinks: links.length, fetchedSources: pages.length, sourceDomainDiversity: domains.length, trustedSourceCount, numericClaims: stats.numericClaims.length, checkedClaims: checkedClaims.length, supportedClaims, unsupportedClaims: checkedClaims.length - supportedClaims, claimSupportRatio, confidence: pages.length >= 2 && checkedClaims.length >= 5 && claimSupportRatio >= 70 ? "high" : pages.length && checkedClaims.length >= 2 && claimSupportRatio >= 45 ? "medium" : "low" } };
}
async function fetchEvidencePage(link) { try { const html = await fetchWithNodeClient(link.url, { allowAnyContentType: true, timeout: SOURCE_TIMEOUT }); return { ...link, status: "fetched", host: host(link.url), message: "Evidence page fetched.", text: normalizeEvidence(htmlToText(html)) }; } catch { return { ...link, status: "unfetched", host: host(link.url), message: "Evidence page could not be fetched.", text: "" }; } }
function verifyClaim(claim, pages) { const page = pages.find((source) => claim.numberForms.some((form) => source.text.includes(form)) && claim.contextTerms.filter((term) => source.text.includes(term)).length >= Math.min(2, claim.contextTerms.length || 1)); return { sentence: claim.sentence, numbers: claim.numbers, status: page ? "supported" : "unsupported", sourceUrl: page?.url || "", sourceHost: page?.host || "", detail: page ? `Matched ${page.host}.` : "No fetched source contained the number and enough context." }; }

function editorNotes(article, stats, gates, scores, linkReport, evidence, extraction, aiReview) { const fails = gates.filter((gate) => gate.status === "fail").length; const warns = gates.filter((gate) => gate.status === "warning").length; const strongest = Object.entries(scores).sort((a, b) => b[1] - a[1])[0]; const weakest = Object.entries(scores).sort((a, b) => a[1] - b[1])[0]; const notes = [`${fails} fail gates and ${warns} warning gates require editor review.`]; if (strongest) notes.push(`Strongest section: ${strongest[0]} (${strongest[1]}).`); if (weakest) notes.push(`Weakest section: ${weakest[0]} (${weakest[1]}).`); if (extraction.status !== "pass") notes.push(extraction.detail); if (article.wordCount < 700) notes.push("The article is short for the 700-800 word target and needs more reporting or context."); if (stats.readability.fleschKincaidGrade > 11) notes.push(`Readability is heavy: grade ${stats.readability.fleschKincaidGrade}, Gunning Fog ${stats.readability.gunningFog}.`); if (evidence.summary.checkedClaims && evidence.summary.claimSupportRatio < 70) notes.push(`Only ${evidence.summary.supportedClaims}/${evidence.summary.checkedClaims} numeric claims matched linked evidence pages.`); if (linkReport.checked.some((link) => link.status === "fail")) notes.push("Repair or remove failed links before publishing."); if (aiReview?.status === "ok") notes.push(...(aiReview.summary_notes || []).slice(0, 3).map((note) => `Editorial intelligence: ${note}`)); else if (aiReview?.status && !["disabled"].includes(aiReview.status)) notes.push(aiReview.message); return notes; }
function suggestedFixes(article, stats, gates, evidence) { const fixes = []; if (!stats.titleHasKeyword || !stats.introHasKeyword || !stats.metaHasKeyword || stats.h2KeywordCount < 2) fixes.push(`Place "${stats.keyword}" in the title, intro, meta description, and at least two H2s.`); if (article.wordCount < 700) fixes.push("Add market context, technical levels, catalyst, and a risk paragraph to reach 700-800 words."); if (stats.readability.longSentenceRatio > 20) fixes.push("Review or split sentences over 20 words until long sentences are under 20% of the copy."); if (stats.readability.fleschKincaidGrade > 11) fixes.push("Lower the grade level by shortening clauses and replacing abstract wording with simple verbs."); if (stats.namedSourceLinks < 2) fixes.push("Name and link at least two external credible sources."); if (evidence.summary.sourceDomainDiversity < 2) fixes.push("Add evidence from at least two distinct external source domains."); if (evidence.summary.checkedClaims && evidence.summary.claimSupportRatio < 70) fixes.push("Attach source links for unsupported numeric claims or revise the numbers to match cited evidence."); if (!article.metaDescription) fixes.push("Write a concise meta description with the focus keyword."); if (stats.promotionalMatches.length) fixes.push("Edit promotional phrases so claims are verifiable and supported by precise nouns."); if (stats.aiPhraseMatches.length) fixes.push("Review generic AI-like transitions and require article-specific facts where language feels templated."); return fixes.length ? fixes : ["No major structural fixes are required. Do a final copy edit for precision and style."]; }

function readabilityStats(sentences, tokens, paragraphs) { const sentenceWords = sentences.map((sentence) => countWords(sentence)).filter(Boolean); const paragraphWords = paragraphs.map((paragraph) => countWords(paragraph)).filter(Boolean); const syllables = tokens.reduce((sum, word) => sum + syllableCount(word), 0); const complex = tokens.filter((word) => !/\d/.test(word) && syllableCount(word) >= 3).length; const sentenceCount = Math.max(sentenceWords.length, 1); const wordCount = Math.max(tokens.length, 1); const asl = wordCount / sentenceCount; const asw = syllables / wordCount; const flesch = 206.835 - 1.015 * asl - 84.6 * asw; const grade = 0.39 * asl + 11.8 * asw - 15.59; const fog = 0.4 * (asl + 100 * complex / wordCount); const long = sentenceWords.filter((count) => count > 20).length; return { fleschReadingEase: round(clamp(flesch, -20, 120), 1), fleschKincaidGrade: round(clamp(grade, 0, 20), 1), gunningFog: round(clamp(fog, 0, 25), 1), longSentenceCount: long, veryLongSentenceCount: sentenceWords.filter((count) => count > 30).length, longSentenceRatio: sentences.length ? round(long / sentences.length * 100, 1) : 0, complexWordRatio: round(complex / wordCount * 100, 1), paragraphCount: paragraphWords.length, averageParagraphWords: paragraphWords.length ? round(avg(paragraphWords), 1) : tokens.length, shortestSentenceWords: sentenceWords.length ? Math.min(...sentenceWords) : 0, longestSentenceWords: sentenceWords.length ? Math.max(...sentenceWords) : 0 }; }
function numericClaims(text) { return splitSentences(text).filter((sentence) => /\d/.test(sentence) && /(btc|bitcoin|usd|dollar|price|target|share|stock|million|billion|percent|%|held|sold|valued|debt|market|rank|no\.)/i.test(sentence)).slice(0, 18).map((sentence) => { const nums = (sentence.match(/[$£€]?\d+(?:,\d{3})*(?:\.\d+)?\s?(?:%|percent|btc|usd|dollars|million|billion|trillion|m|bn|k)?/gi) || []).map(clean).filter(Boolean); return { sentence: truncate(sentence, 220), numbers: [...new Set(nums)], numberForms: [...new Set(nums.flatMap(numberForms))], contextTerms: words(sentence).filter((word) => word.length > 3 && !STOP.has(word) && !/^\d+$/.test(word)).slice(0, 10) }; }).filter((claim) => claim.numbers.length); }
function numberForms(value) { const base = normalizeEvidence(value); const digits = base.match(/\d+(?:\.\d+)?/g) || []; return [base, base.replaceAll(" ", ""), ...digits].filter((item) => item.length >= 2); }
function evidenceLinks(links, articleUrl) { return dedupe(links.filter((link) => { if (!link.url || !link.text || !/^https?:/i.test(link.url)) return false; if (sameSite(link.url, articleUrl)) return false; const h = host(link.url); if (SOCIAL.some((domain) => h === domain || h.endsWith(`.${domain}`))) return false; if (/\/tag\/|\/category\/|\/author\/|privacy|terms|contact|about|advertis|share/i.test(link.url)) return false; return true; }), "url"); }
function profileSentences(sentences) { const longSentences = sentences.map((sentence, index) => ({ sentence, index: index + 1, words: countWords(sentence) })).filter((item) => item.words > 20).sort((a, b) => b.words - a.words).slice(0, 6); const map = new Map(); sentences.forEach((sentence, index) => { const opening = words(sentence).slice(0, 1).join(" "); if (!opening || STOP.has(opening) || opening.length < 4) return; if (!map.has(opening)) map.set(opening, []); map.get(opening).push({ sentence, index: index + 1 }); }); const repetitiveOpenings = [...map.entries()].filter(([, examples]) => examples.length >= 3).map(([opening, examples]) => ({ opening, count: examples.length, examples: examples.slice(0, 3) })).slice(0, 4); return { longSentences, repetitiveOpenings }; }
function splitSentences(text) { return clean(text).split(/(?<=[.!?])\s+/).map(clean).filter((sentence) => sentence.length > 5); }
function splitParagraphs(text) { return String(text || "").split(/\n\s*\n/).map(clean).filter(Boolean); }
function stripMarkdown(text) { return clean(String(text || "").replace(/!\[[^\]]*]\([^)]+\)/g, "").replace(/\[([^\]]+)]\(([^)]+)\)/g, "$1").replace(/^#{1,6}\s+/gm, "").replace(/[*_`>~-]/g, " ")); }
function markdownLinks(text, fallbackUrl) { const links = []; for (const match of String(text).matchAll(/(?<!!)\[([^\]]+)]\((https?:\/\/[^)\s]+)\)/gi)) links.push({ text: clean(match[1]), url: absoluteUrl(match[2], fallbackUrl) }); for (const match of String(text).matchAll(/https?:\/\/[^\s)]+/gi)) { const url = match[0].replace(/[.,;:!?]+$/, ""); links.push({ text: host(url) || url, url: absoluteUrl(url, fallbackUrl) }); } return dedupe(links, "url"); }
function markdownImages(text, fallbackUrl) { return dedupe([...String(text).matchAll(/!\[([^\]]*)]\((https?:\/\/[^)\s]+)\)/gi)].map((match) => ({ alt: clean(match[1]), src: absoluteUrl(match[2], fallbackUrl) })), "src"); }
function mergeEvidenceLinks(links, evidenceUrls) { const manual = String(evidenceUrls || "").split(/\r?\n|,/).map((value) => normalizeUrl(value.trim())).filter(Boolean).map((url) => ({ text: host(url) || url, url })); return dedupe([...(links || []), ...manual], "url"); }
function buildContextMap(article, limit = 12) { return (article.paragraphs || []).filter(Boolean).slice(0, limit).map((paragraph, index) => ({ id: `p${index + 1}`, label: `Paragraph ${index + 1}`, text: truncate(paragraph, 420), sentences: splitSentences(paragraph).slice(0, 6).map((sentence, sentenceIndex) => ({ id: `p${index + 1}s${sentenceIndex + 1}`, label: `Sentence ${sentenceIndex + 1}`, text: truncate(sentence, 260), words: countWords(sentence) })) })); }
function findLocation(article, snippet) { const needle = clean(snippet).toLowerCase(); if (!needle) return "Article body"; for (const [pIndex, paragraph] of (article.paragraphs || []).entries()) { const p = clean(paragraph); if (!p.toLowerCase().includes(needle.slice(0, Math.min(needle.length, 80)))) continue; const sentences = splitSentences(p); const sIndex = sentences.findIndex((sentence) => sentence.toLowerCase().includes(needle.slice(0, Math.min(needle.length, 80)))); return sIndex >= 0 ? `Paragraph ${pIndex + 1}, sentence ${sIndex + 1}` : `Paragraph ${pIndex + 1}`; } return "Article body"; }
function fetchHtml(url) { return fetchWithNodeClient(url, { allowAnyContentType: false, timeout: REQUEST_TIMEOUT }).catch(async () => { const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT); try { const response = await fetch(url, { signal: controller.signal, headers: requestHeaders() }); if (!response.ok) throw new Error(`The article returned HTTP ${response.status}.`); return response.text(); } finally { clearTimeout(timer); } }); }
function fetchWithNodeClient(url, options = {}) { return new Promise((resolve, reject) => { const parsed = new URL(url); const client = parsed.protocol === "http:" ? http : https; const request = client.get(parsed, { family: 4, timeout: options.timeout || REQUEST_TIMEOUT, headers: requestHeaders() }, (response) => { if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) { response.resume(); resolve(fetchWithNodeClient(new URL(response.headers.location, url).toString(), options)); return; } if (response.statusCode < 200 || response.statusCode >= 300) { response.resume(); reject(new Error(`The URL returned HTTP ${response.statusCode}.`)); return; } const type = response.headers["content-type"] || ""; if (!options.allowAnyContentType && !type.includes("text/html") && !type.includes("application/xhtml")) { response.resume(); reject(new Error("The URL does not appear to be an HTML article.")); return; } const chunks = []; response.on("data", (chunk) => chunks.push(chunk)); response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8"))); }); request.on("timeout", () => request.destroy(new Error("The request timed out."))); request.on("error", reject); }); }
function requestHeaders() { return { accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", "accept-language": "en-US,en;q=0.9", "user-agent": "Mozilla/5.0 ContentAuditTool/1.0" }; }
function firstText($, selectors) { for (const selector of selectors) { const node = $(selector).first(); const value = clean(node.attr("content") || node.attr("datetime") || node.text()); if (value) return value; } return ""; }
function htmlToText(html) { const $ = cheerio.load(html); $("script, style, noscript, svg, canvas, iframe, form").remove(); return clean($("body").text() || $.root().text()); }
function normalizeUrl(value) { if (!value || typeof value !== "string") return ""; try { const url = new URL(value.trim().startsWith("http") ? value.trim() : `https://${value.trim()}`); return ["http:", "https:"].includes(url.protocol) ? url.toString() : ""; } catch { return ""; } }
function inferTitle(content) { return String(content || "").split(/\r?\n/).map((line) => clean(stripMarkdown(line))).find((line) => line.length >= 10 && line.length <= 140) || ""; }
function words(text) { return clean(text).toLowerCase().match(/[a-z0-9]+(?:['-][a-z0-9]+)?/g) || []; }
function countWords(text) { return words(text).length; }
function clean(value) { return String(value || "").replace(/\s+/g, " ").trim(); }
function findPhrases(text, phrases) { const lower = String(text || "").toLowerCase(); return [...new Set(phrases.filter((phrase) => lower.includes(phrase)))]; }
function termHits(text, terms) { const lower = String(text || "").toLowerCase(); return terms.reduce((sum, term) => sum + (lower.includes(term) ? 1 : 0), 0); }
function countPhrase(text, phrase) { if (!phrase) return 0; return String(text || "").toLowerCase().split(phrase.toLowerCase()).length - 1; }
function hasPhrase(text, phrase) { return Boolean(phrase && String(text || "").toLowerCase().includes(phrase.toLowerCase())); }
function countPassive(sentences) { const be = new Set(["is", "are", "was", "were", "be", "been", "being"]); return sentences.filter((sentence) => { const tokens = words(sentence); return tokens.some((token, index) => be.has(token) && tokens[index + 1] && (tokens[index + 1].endsWith("ed") || tokens[index + 1].endsWith("en"))); }).length; }
function syllableCount(word) { const cleaned = word.toLowerCase().replace(/[^a-z]/g, ""); if (cleaned.length <= 3) return 1; const groups = cleaned.replace(/e$/, "").match(/[aeiouy]+/g); return Math.max(groups ? groups.length : 1, 1); }
function headlineMatch(title, body) { const bodySet = new Set(words(body)); const important = words(title).filter((word) => word.length > 3 && !STOP.has(word)); return important.length ? important.filter((word) => bodySet.has(word)).length / important.length >= 0.5 : false; }
function inferKeyword(title, body) { const counts = new Map(); [...words(title), ...words(title), ...words(body)].filter((word) => word.length > 3 && !STOP.has(word)).forEach((word) => counts.set(word, (counts.get(word) || 0) + 1)); return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([word]) => word).join(" "); }
function priceTargets(title) { return (title.match(/[$£€]\s?\d+(?:,\d{3})*(?:\.\d+)?|\b\d+(?:\.\d+)?\s?(?:usd|dollars|price target|target|%)/gi) || []).map(clean); }
function normalizeEvidence(value) { return clean(value).toLowerCase().replace(/[,'’‘$£€]/g, " ").replace(/percent/g, "%"); }
function stripSite(title) { return clean(title).replace(/\s+[-|]\s+[^-|]+$/, ""); }
function cleanByline(author) { return clean(author).replace(/^by\s+/i, "").replace(/\s+\|\s+.+$/, ""); }
function formatDate(date) { const parsed = new Date(clean(date)); return Number.isNaN(parsed.getTime()) ? clean(date) : parsed.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }); }
function absoluteUrl(value, base) { try { return value ? new URL(value, base).toString() : ""; } catch { return ""; } }
function dedupe(items, key) { const seen = new Set(); return items.filter((item) => { const value = item[key]; if (!value || seen.has(value)) return false; seen.add(value); return true; }); }
function sameSite(url, base) { const a = host(url); const b = host(base); return a && b && (a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`)); }
function host(url) { try { return new URL(url).hostname.replace(/^www\./i, "").toLowerCase(); } catch { return ""; } }
function trustedHost(h) { return TRUSTED.some((domain) => h === domain || h.endsWith(`.${domain}`)) || /\.(gov|edu)$/i.test(h); }
function gate(name, status, detail) { return { name, status, detail }; }
function scoreItem(name, score, detail, weight = 1) { return { name, score: Math.round(clamp(score)), detail, weight }; }
function section(items) { const totalWeight = items.reduce((sum, item) => sum + item.weight, 0) || 1; return { score: Math.round(items.reduce((sum, item) => sum + item.score * item.weight, 0) / totalWeight), items }; }
function hitScore(hits, target) { return clamp(hits / target * 100); }
function rangeScore(value, idealLow, idealHigh, min, max) { if (!value) return 0; if (value >= idealLow && value <= idealHigh) return 100; if (value < idealLow) return clamp((value - min) / (idealLow - min) * 100); return clamp((max - value) / (max - idealHigh) * 100); }
function avg(values) { const nums = values.filter(Number.isFinite); return nums.length ? nums.reduce((sum, value) => sum + value, 0) / nums.length : 0; }
function clamp(value, min = 0, max = 100) { return Math.min(max, Math.max(min, Number.isFinite(value) ? value : 0)); }
function round(value, places = 0) { const factor = 10 ** places; return Math.round(value * factor) / factor; }
function truncate(value, maxLength) { const text = clean(value); return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text; }
function capitalize(value) { const text = String(value || ""); return text ? text.charAt(0).toUpperCase() + text.slice(1) : ""; }
function yes(value) { return value ? "yes" : "no"; }
function isUsefulText(text) { if (!text || text.length < 25) return false; return !/^(sign up|subscribe|advertisement|related articles|share this|follow us)/i.test(text); }
