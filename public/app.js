const form = document.querySelector("#auditForm");
const runButton = document.querySelector("#runButton");
const statusPanel = document.querySelector("#statusPanel");
const dashboard = document.querySelector("#dashboard");

const elements = {
  compositeScore: document.querySelector("#compositeScore"),
  articleTitle: document.querySelector("#articleTitle"),
  articleLink: document.querySelector("#articleLink"),
  author: document.querySelector("#author"),
  date: document.querySelector("#date"),
  wordCount: document.querySelector("#wordCount"),
  keywordDensity: document.querySelector("#keywordDensity"),
  h2Count: document.querySelector("#h2Count"),
  keyword: document.querySelector("#keyword"),
  avgSentence: document.querySelector("#avgSentence"),
  fleschScore: document.querySelector("#fleschScore"),
  gradeLevel: document.querySelector("#gradeLevel"),
  claimSupport: document.querySelector("#claimSupport"),
  evidenceSources: document.querySelector("#evidenceSources"),
  accuracyConfidence: document.querySelector("#accuracyConfidence"),
  diagnosticsGrid: document.querySelector("#diagnosticsGrid"),
  category: document.querySelector("#category"),
  linksCount: document.querySelector("#linksCount"),
  imagesCount: document.querySelector("#imagesCount"),
  metaDescription: document.querySelector("#metaDescription"),
  h2Headings: document.querySelector("#h2Headings"),
  linksList: document.querySelector("#linksList"),
  imagesList: document.querySelector("#imagesList"),
  bodyPreview: document.querySelector("#bodyPreview"),
  scoreBreakdown: document.querySelector("#scoreBreakdown"),
  qualityGates: document.querySelector("#qualityGates"),
  gateTotals: document.querySelector("#gateTotals"),
  editorNotes: document.querySelector("#editorNotes"),
  suggestedFixes: document.querySelector("#suggestedFixes")
};

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  setLoading(true);
  showStatus("Fetching and scoring the article...");
  try {
    const response = await fetch("/api/audit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: document.querySelector("#articleUrl").value.trim(),
        focusKeyword: document.querySelector("#focusKeyword").value.trim()
      })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Audit failed.");
    renderDashboard(payload);
    statusPanel.classList.add("hidden");
    dashboard.classList.remove("hidden");
  } catch (error) {
    dashboard.classList.add("hidden");
    showStatus(error.message || "The audit could not be completed.", true);
  } finally {
    setLoading(false);
  }
});

function renderDashboard(data) {
  const { article, scores, gates, readability, credibility } = data;
  elements.compositeScore.textContent = data.compositeScore;
  elements.articleTitle.textContent = article.title;
  elements.articleLink.textContent = article.url;
  elements.articleLink.href = article.url;
  elements.author.textContent = article.author;
  elements.date.textContent = article.date;
  elements.wordCount.textContent = article.wordCount.toLocaleString();
  elements.keywordDensity.textContent = `${data.keywordDensity}%`;
  elements.h2Count.textContent = article.h2Count;
  elements.keyword.textContent = data.keyword || "Not detected";
  elements.avgSentence.textContent = `${readability.averageSentenceLength || 0} words`;
  elements.fleschScore.textContent = readability.fleschReadingEase;
  elements.gradeLevel.textContent = readability.fleschKincaidGrade;
  elements.claimSupport.textContent = credibility.checkedClaims ? `${credibility.claimSupportRatio}%` : "N/A";
  elements.evidenceSources.textContent = `${credibility.fetchedSources}/${credibility.evidenceLinks}`;
  elements.accuracyConfidence.textContent = credibility.confidence;
  elements.category.textContent = article.category;
  elements.linksCount.textContent = article.linksCount;
  elements.imagesCount.textContent = article.imagesCount;
  elements.metaDescription.textContent = article.metaDescription || "Not found";
  elements.bodyPreview.textContent = article.bodyPreview || "Not enough body text was extracted.";
  renderList(elements.h2Headings, article.h2Headings.length ? article.h2Headings : ["No H2 headings found."]);
  renderLinkList(elements.linksList, article.links, "No links found.");
  renderImageList(elements.imagesList, article.images);
  renderDiagnostics(readability, credibility);

  elements.scoreBreakdown.innerHTML = Object.entries(scores).map(([name, score]) => {
    const details = data.scoreDetails?.[name]?.items || [];
    return `<article class="score-row"><div><strong>${escapeHtml(name)}</strong><span>${score}/100</span></div><div class="bar" aria-hidden="true"><span style="width: ${score}%"></span></div><ul class="subscore-list">${details.map((item) => `<li><b>${escapeHtml(item.name)}:</b> ${item.score}/100 <span>${escapeHtml(item.detail)}</span></li>`).join("")}</ul></article>`;
  }).join("");

  const totals = gates.reduce((acc, gate) => {
    acc[gate.status] = (acc[gate.status] || 0) + 1;
    return acc;
  }, {});
  elements.gateTotals.innerHTML = ["pass", "warning", "fail"].map((status) => `<span class="badge ${status}">${totals[status] || 0} ${status}</span>`).join("");
  elements.qualityGates.innerHTML = gates.map((gate) => `<article class="gate-card ${gate.status}"><div class="gate-card-head"><strong>${escapeHtml(gate.name)}</strong><span class="badge ${gate.status}">${gate.status}</span></div><p>${escapeHtml(gate.detail)}</p></article>`).join("");
  renderList(elements.editorNotes, data.editorNotes);
  renderList(elements.suggestedFixes, data.suggestedFixes);
}

function renderDiagnostics(readability, credibility) {
  const diagnostics = [
    ["Average sentence length", `${readability.averageSentenceLength || 0} words`],
    ["Long sentences", `${readability.longSentenceRatio}% over 20 words`],
    ["Longest sentence", `${readability.longestSentenceWords || 0} words`],
    ["Passive ratio", `${readability.passiveRatio || 0}%`],
    ["Gunning Fog", readability.gunningFog],
    ["Complex words", `${readability.complexWordRatio}%`],
    ["Numeric claims found", credibility.numericClaims],
    ["Claims checked", credibility.checkedClaims],
    ["Claims supported", `${credibility.supportedClaims}/${credibility.checkedClaims}`],
    ["Source domains", credibility.sourceDomainDiversity],
    ["High-authority sources", credibility.trustedSourceCount],
    ["Evidence confidence", credibility.confidence]
  ];
  elements.diagnosticsGrid.innerHTML = diagnostics.map(([label, value]) => `<article class="diagnostic"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></article>`).join("");
}

function renderList(node, items) {
  node.innerHTML = items.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
}

function renderLinkList(node, links, emptyText) {
  node.innerHTML = links.length ? links.map((link) => `<li><a href="${escapeAttribute(link.url)}" target="_blank" rel="noreferrer">${escapeHtml(link.text || link.url)}</a></li>`).join("") : `<li>${escapeHtml(emptyText)}</li>`;
}

function renderImageList(node, images) {
  node.innerHTML = images.length ? images.map((image) => `<li><a href="${escapeAttribute(image.src)}" target="_blank" rel="noreferrer">${escapeHtml(image.alt || image.src)}</a></li>`).join("") : "<li>No images found.</li>";
}

function setLoading(isLoading) {
  runButton.disabled = isLoading;
  runButton.textContent = isLoading ? "Auditing..." : "Run Audit";
}

function showStatus(message, isError = false) {
  statusPanel.textContent = message;
  statusPanel.className = `status-panel ${isError ? "error" : ""}`;
}

function escapeHtml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, "&#096;");
}
