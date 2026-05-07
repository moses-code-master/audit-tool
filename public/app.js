const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

const form = $('#auditForm');
const runButton = $('#runButton');
const statusPanel = $('#statusPanel');
const dashboard = $('#dashboard');
const pasteField = $('.paste-field');
const articleContent = $('#articleContent');
const themeToggle = $('#themeToggle');
const exportButton = $('#exportButton');
const shareButton = $('#shareButton');
let lastAudit = null;

const fields = {
  score: $('#compositeScore'), scoreArc: $('#scoreArc'), title: $('#articleTitle'), link: $('#articleLink'), heroSummary: $('#heroSummary'),
  categoryTag: $('#categoryTag'), auditTimestamp: $('#auditTimestamp'), author: $('#author'), date: $('#date'), wordCount: $('#wordCount'), readTime: $('#readTime'),
  heroConfidence: $('#heroConfidence'), heroAiRisk: $('#heroAiRisk'), kpiGrid: $('#kpiGrid'), scoreAnalytics: $('#scoreAnalytics'), qualityPanel: $('#qualityPanel'),
  contentGlance: $('#contentGlance'), outlinePanel: $('#outlinePanel'), preview: $('#preview'), issuesPanel: $('#issuesPanel'), aiPanel: $('#ai-analysis'),
  competitors: $('#competitors'), distribution: $('#distributionPanel'), risk: $('#publishing-risk'), diagnostics: $('#readability'), evidence: $('#sources'), auditRuntime: $('#auditRuntime')
};

const labels = {
  url: ['Published article URL', 'https://example.com/article'],
  docs: ['Public Google Docs link', 'https://docs.google.com/document/d/...'],
  notion: ['Public Notion link', 'https://notion.site/...'],
  paste: ['Optional source URL', 'https://example.com/original-source']
};

$$('.mode-tab').forEach((tab) => tab.addEventListener('click', () => setMode(tab.dataset.mode)));

function setMode(mode) {
  $$('.mode-tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.mode === mode));
  pasteField.classList.toggle('hidden', mode !== 'paste');
  $('#urlLabel').textContent = labels[mode][0];
  $('#articleUrl').placeholder = labels[mode][1];
}

function forcePasteMode() {
  setMode('paste');
  pasteField.classList.remove('hidden');
  $$('.mode-tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.mode === 'paste'));
  articleContent.placeholder = 'Paste the full article text here, then click Run Audit again.';
  setTimeout(() => {
    articleContent.focus();
    articleContent.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, 0);
}

themeToggle.addEventListener('click', () => {
  document.body.classList.toggle('theme-light');
  const isLight = document.body.classList.contains('theme-light');
  themeToggle.textContent = isLight ? 'Light' : 'Dark';
  localStorage.setItem('audit-theme', isLight ? 'light' : 'dark');
});

if (localStorage.getItem('audit-theme') === 'light') {
  document.body.classList.add('theme-light');
  themeToggle.textContent = 'Light';
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const url = $('#articleUrl').value.trim();
  const content = articleContent.value.trim();
  if (!url && !content) return showStatus('Enter a URL, a public Docs/Notion link, or paste article content.', true);

  setLoading(true);
  showStatus('<div class="loading-stack"><div><span></span><span></span><span></span></div><strong>Running editorial audit...</strong><p>Scraping content, checking evidence, and building the report.</p></div>', false, true);

  try {
    const started = performance.now();
    const response = await fetch('/api/audit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url,
        content,
        focusKeyword: $('#focusKeyword').value.trim(),
        enableAi: $('#enableAi').checked,
        title: $('#manualTitle').value.trim(),
        author: $('#manualAuthor').value.trim(),
        date: $('#manualDate').value.trim(),
        category: $('#manualCategory').value.trim(),
        metaDescription: $('#manualMeta').value.trim(),
        evidenceUrls: $('#evidenceUrls').value.trim()
      })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Audit failed.');

    payload.auditDuration = ((performance.now() - started) / 1000).toFixed(1);
    lastAudit = payload;
    renderDashboard(payload);
    statusPanel.classList.add('hidden');
    dashboard.classList.remove('hidden');
  } catch (error) {
    dashboard.classList.add('hidden');
    const message = error.message || 'The audit could not be completed.';
    if (isBlockedFetchError(message) && !content) {
      forcePasteMode();
      showStatus(blockedUrlMessage(url, message), true, true);
    } else {
      showStatus(esc(message), true, true);
    }
  } finally {
    setLoading(false);
  }
});

exportButton.addEventListener('click', () => {
  if (!lastAudit) return window.print();
  const blob = new Blob([JSON.stringify(lastAudit, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `content-audit-${Date.now()}.json`;
  link.click();
  URL.revokeObjectURL(url);
});

shareButton.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(window.location.href);
    shareButton.textContent = 'Copied';
    setTimeout(() => { shareButton.textContent = 'Share'; }, 1400);
  } catch {
    window.print();
  }
});

document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-jump-target]');
  if (!button) return;
  const target = $(button.getAttribute('data-jump-target'));
  if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
});

function renderDashboard(data) {
  const article = data.article || {};
  const score = Number(data.compositeScore || 0);
  const confidence = confidenceState(data);
  const aiRisk = aiRiskState(data);
  const readTime = Math.max(1, Math.ceil((article.wordCount || 0) / 220));

  fields.score.textContent = score;
  fields.scoreArc.style.strokeDashoffset = `${314 - (314 * score) / 100}`;
  fields.title.textContent = article.title || 'Untitled article';
  fields.link.textContent = article.url || '';
  fields.link.href = String(article.url || '').startsWith('http') ? article.url : '#';
  fields.heroSummary.textContent = article.metaDescription || article.bodyPreview || 'No summary was extracted.';
  fields.categoryTag.textContent = article.category || 'News article';
  fields.auditTimestamp.textContent = `Audited ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  fields.author.textContent = article.author || 'Not found';
  fields.date.textContent = article.date || 'Not found';
  fields.wordCount.textContent = Number(article.wordCount || 0).toLocaleString();
  fields.readTime.textContent = `${readTime} min`;
  fields.heroConfidence.innerHTML = pill(confidence.label, confidence.status);
  fields.heroAiRisk.innerHTML = pill(aiRisk.label, aiRisk.status);
  fields.auditRuntime.textContent = `Audit completed in ${data.auditDuration || '-'}s`;

  renderKpis(data, confidence, aiRisk);
  renderScores(data);
  renderGates(data);
  renderContent(data);
  renderIssues(data);
  renderIntel(data);
  renderBenchmarks(data);
  renderDistribution(data);
  renderRisk(data);
  renderDiagnostics(data);
  renderEvidence(data);
}

function renderKpis(data, confidence, aiRisk) {
  const article = data.article || {};
  const credibility = data.credibility || {};
  const extraction = data.extractionQuality || { label: 'Unknown', status: 'warning', detail: 'Extraction confidence unavailable.' };
  const kpis = [
    ['EX', 'Extraction', extraction.label, gateStatus(extraction.status), extraction.detail],
    ['KD', 'Keyword Density', `${data.keywordDensity || 0}%`, densityStatus(data.keywordDensity || 0), data.keyword || 'Focus keyword'],
    ['H2', 'H2 Headings', article.h2Count || 0, (article.h2Count || 0) >= 2 && (article.h2Count || 0) <= 3 ? 'good' : 'warn', 'Target 2-3'],
    ['EV', 'Evidence Sources', `${credibility.fetchedSources || 0}/${credibility.evidenceLinks || 0}`, credibility.fetchedSources ? 'good' : 'bad', 'Fetched source pages'],
    ['CF', 'Confidence', confidence.label, confidence.status, 'Evidence confidence'],
    ['AR', 'AI Risk', aiRisk.label, aiRisk.status, data.aiReview?.status || 'rules only']
  ];
  fields.kpiGrid.innerHTML = kpis.map(([icon, label, value, status, detail]) => `<article class="kpi-card ${status}"><span class="kpi-icon">${esc(icon)}</span><div><p>${esc(label)}</p><strong>${esc(value)}</strong><small>${esc(detail)}</small></div>${pill(labelFor(status), status)}</article>`).join('');
}

function renderScores(data) {
  const entries = Object.entries(data.scores || {});
  fields.scoreAnalytics.innerHTML = `<div class="panel-heading"><div><p class="eyebrow">Editorial scoring</p><h3>Score Breakdown</h3></div></div><div class="score-bars">${entries.map(([name, score]) => `<div class="score-bar-row"><span>${esc(name)}</span><div class="bar-track"><i class="bar-fill" style="width:${Number(score || 0)}%"></i></div><strong class="score-value">${esc(score)}/100</strong></div>`).join('')}</div>`;
}

function renderGates(data) {
  const gates = data.gates || [];
  const totals = countStatuses(gates);
  fields.qualityPanel.innerHTML = `<div class="panel-heading"><div><p class="eyebrow">Pass, warning, fail</p><h3>Quality Gates</h3></div></div><div class="gate-summary"><strong class="pass">${totals.pass || 0}<span>Pass</span></strong><strong class="warning">${totals.warning || 0}<span>Warning</span></strong><strong class="fail">${totals.fail || 0}<span>Fail</span></strong></div><div class="gate-list">${[...gates].sort((a, b) => rank(a.status) - rank(b.status)).slice(0, 8).map((gate) => `<details class="gate-line ${gate.status}" ${gate.status !== 'pass' ? 'open' : ''}><summary><span>${gate.status === 'pass' ? 'OK' : gate.status === 'warning' ? '!' : 'X'}</span>${esc(gate.name)}${pill(gate.status, gate.status)}</summary><p>${esc(gate.detail)}</p></details>`).join('')}</div>`;
}

function renderContent(data) {
  const article = data.article || {};
  const external = Math.max(0, (article.linksCount || 0) - internalLinks(article.links || []));
  const cards = [['Category', article.category || 'Not found'], ['Images', article.imagesCount || 0], ['Internal Links', internalLinks(article.links || [])], ['External Links', external], ['H2 Headings', article.h2Count || 0], ['Meta Description', article.metaDescription ? `${article.metaDescription.length} chars` : 'Missing']];
  fields.contentGlance.innerHTML = `<div class="panel-heading"><div><p class="eyebrow">Content At-A-Glance</p><h3>Extracted signals</h3></div></div><div class="glance-grid">${cards.map(([label, value]) => `<article><span>${esc(label)}</span><strong>${esc(value)}</strong></article>`).join('')}</div>`;
  fields.outlinePanel.innerHTML = `<div class="panel-heading"><div><p class="eyebrow">Structure</p><h3>Top H2 Headings</h3></div></div><ol class="outline-list">${(article.h2Headings?.length ? article.h2Headings : ['No H2 headings found']).slice(0, 5).map((heading) => `<li>${esc(heading)}</li>`).join('')}</ol>`;
  const paragraphs = article.paragraphs?.length ? article.paragraphs.map((p) => p.text || p) : [article.bodyPreview || 'No body text was extracted.'];
  fields.preview.innerHTML = `<div class="panel-heading"><div><p class="eyebrow">Content preview</p><h3>Editorial readout</h3></div></div><div class="preview-copy">${paragraphs.slice(0, 8).map((text, index) => `<p><span>Paragraph ${index + 1}</span>${esc(text)}</p>`).join('')}</div>`;
}

function renderIssues(data) {
  const issues = (data.gates || []).filter((gate) => gate.status !== 'pass');
  fields.issuesPanel.innerHTML = `<div class="panel-heading"><div><p class="eyebrow">Issues detected (${issues.length})</p><h3>Prioritized editorial queue</h3></div></div><div class="issue-list">${issues.slice(0, 8).map((gate) => `<article class="issue-row ${gate.status}"><strong>${esc(gate.status)}</strong><div><h4>${esc(gate.name)}</h4><p>${esc(gate.detail)}</p></div><span>${gate.status === 'fail' ? 'High' : 'Medium'} impact</span></article>`).join('') || '<p class="muted">No fail or warning gates detected.</p>'}</div>`;
}

function renderIntel(data) {
  const flags = getFlags(data);
  fields.aiPanel.innerHTML = `<div class="panel-heading"><div><p class="eyebrow">Verification assistant</p><h3>Editorial Intelligence</h3><p class="muted">${esc(data.aiReview?.status === 'ok' ? `Model reviewed by ${data.aiReview.model}` : 'Rules-based verification view')}</p></div></div><div class="intel-list">${flags.slice(0, 8).map((flag) => `<details class="intel-card ${esc(flag.severity || 'medium')}" open><summary>${pill(flag.severity || 'medium', flag.severity === 'high' ? 'fail' : 'warning')}<strong>${esc(labelCategory(flag.category))}</strong><span>${esc(flag.location || 'Audit gate')}</span></summary><div class="flagged-snippet"><b>Flag</b><mark>${esc(flag.flag || 'Contextual issue')}</mark></div><dl class="intel-details"><div><dt>Issue</dt><dd>${esc(flag.issue || 'Review before publication.')}</dd></div><div><dt>Recommendation</dt><dd>${esc(flag.recommendation || 'Review before publication.')}</dd></div></dl></details>`).join('') || '<p class="muted">No major editorial intelligence flags detected.</p>'}</div>`;
}

function renderBenchmarks(data) {
  const article = data.article || {};
  const external = Math.max(0, (article.linksCount || 0) - internalLinks(article.links || []));
  fields.competitors.innerHTML = `<div class="panel-heading"><div><p class="eyebrow">Competitor snapshot</p><h3>Your article vs benchmarks</h3></div></div><p class="muted">Live SERP competitors are not connected yet. This view uses newsroom benchmarks.</p><table class="comparison-table"><tbody>${row('Word Count', article.wordCount || 0, '700-800')}${row('Readability', data.readability?.fleschReadingEase || 0, '45+ Flesch')}${row('External Sources', external, '3+ named sources')}${row('Keyword Usage', `${data.keywordDensity || 0}%`, '0.8-1.8%')}</tbody></table>`;
}

function renderDistribution(data) {
  const scores = data.scores || {};
  const readiness = Math.round(((scores['SEO Structure'] || 0) + (scores['Human Voice'] || 0) + (scores['Content Width'] || 0)) / 3);
  fields.distribution.innerHTML = `<div class="panel-heading"><div><p class="eyebrow">Distribution readiness</p><h3>Publishing channels</h3></div></div><div class="mini-dial"><strong>${readiness}</strong><span>/100</span></div><p class="muted">${readiness >= 80 ? 'Strong distribution potential.' : 'Resolve priority issues before wider distribution.'}</p>`;
}

function renderRisk(data) {
  const failCount = (data.gates || []).filter((gate) => gate.status === 'fail').length;
  const risks = [['Reputation Risk', failCount >= 3 ? 'High' : failCount ? 'Medium' : 'Low'], ['SEO Risk', (data.scores?.['SEO Structure'] || 0) < 70 ? 'High' : 'Low'], ['Source Risk', (data.scores?.['E-E-A-T'] || 0) < 60 ? 'Medium' : 'Low']];
  fields.risk.innerHTML = `<div class="panel-heading"><div><p class="eyebrow">Publishing Risk</p><h3>Risk register</h3></div></div><div class="risk-list">${risks.map(([name, level]) => `<article><span>${esc(name)}</span>${pill(level, level === 'High' ? 'fail' : level === 'Medium' ? 'warning' : 'pass')}</article>`).join('')}</div>`;
}

function renderDiagnostics(data) {
  const r = data.readability || {};
  const c = data.credibility || {};
  const items = [['Average sentence', `${r.averageSentenceLength || 0} words`], ['Long sentences', `${r.longSentenceRatio || 0}%`], ['Flesch', r.fleschReadingEase || 0], ['Grade level', r.fleschKincaidGrade || 0], ['Gunning Fog', r.gunningFog || 0], ['Claims checked', c.checkedClaims || 0], ['Claims supported', `${c.supportedClaims || 0}/${c.checkedClaims || 0}`]];
  fields.diagnostics.innerHTML = `<div class="panel-heading"><div><p class="eyebrow">Readability</p><h3>Formula diagnostics</h3></div></div><div class="diagnostics-grid">${items.map(([label, value]) => `<article><span>${esc(label)}</span><strong>${esc(value)}</strong></article>`).join('')}</div>`;
}

function renderEvidence(data) {
  const review = data.evidenceReview || {};
  const sources = review.sourceFetches || [];
  const unsupported = review.unsupportedClaims || [];
  fields.evidence.innerHTML = `<div class="panel-heading"><div><p class="eyebrow">Facts & Sources</p><h3>Claim support and source fetches</h3></div></div><div class="evidence-columns"><div><h4>Unsupported numeric claims</h4><ul>${unsupported.length ? unsupported.map((claim) => `<li><strong>${esc((claim.numbers || []).join(', '))}</strong><span>${esc(claim.sentence)}</span></li>`).join('') : '<li><strong>No unsupported checked claims</strong><span>No fetched evidence conflict was detected.</span></li>'}</ul></div><div><h4>Fetched source pages</h4><ul>${sources.length ? sources.map((source) => `<li><strong>${esc(source.host || source.url)}</strong><span>${esc(source.status)}${source.code ? `, HTTP ${source.code}` : ''}</span></li>`).join('') : '<li><strong>No source pages fetched</strong><span>Add source links or evidence URLs.</span></li>'}</ul></div></div>`;
}

function getFlags(data) {
  if (data.editorialIntelligence?.flags?.length) return data.editorialIntelligence.flags;
  return (data.gates || []).filter((gate) => gate.status !== 'pass').slice(0, 10).map((gate) => ({ category: 'editorial_risk', flag: gate.name, issue: gate.detail, severity: gate.status === 'fail' ? 'high' : 'medium', recommendation: 'Review this gate before publication.' }));
}

function setLoading(isLoading) {
  runButton.disabled = isLoading;
  runButton.textContent = isLoading ? 'Auditing...' : 'Run Audit';
  document.body.classList.toggle('is-loading', isLoading);
}

function showStatus(message, isError = false, asHtml = false) {
  statusPanel[asHtml ? 'innerHTML' : 'textContent'] = message;
  statusPanel.className = `status-panel ${isError ? 'error' : ''}`;
}

function isBlockedFetchError(message) {
  return /HTTP\s*(401|403|429)|forbidden|blocked|rate.?limited/i.test(message);
}

function blockedUrlMessage(url, message) {
  return `<strong>This site blocked the audit request.</strong><p>${esc(message)}</p><p>The article opens for you in your browser, but it blocks the Render server that runs this audit. I opened the Draft content box above. Copy the article body from your browser, paste it there, then click Run Audit again.</p><button class="text-button" type="button" data-jump-target="#articleContent">Go to Draft content</button>${url ? `<p class="muted">Blocked URL: ${esc(url)}</p>` : ''}`;
}

function confidenceState(data) {
  const confidence = data.credibility?.confidence;
  if (confidence === 'high') return { label: 'High', status: 'pass' };
  if (confidence === 'medium') return { label: 'Medium', status: 'warning' };
  return { label: 'Low', status: 'fail' };
}

function aiRiskState(data) {
  const humanVoice = data.scores?.['Human Voice'] || 0;
  const flags = getFlags(data).filter((flag) => String(flag.category || flag.issue || flag.flag).toLowerCase().includes('ai')).length;
  if (flags > 2 || humanVoice < 60) return { label: 'High', status: 'fail' };
  if (flags || humanVoice < 78) return { label: 'Medium', status: 'warning' };
  return { label: 'Low', status: 'pass' };
}

function internalLinks(links) {
  const first = host(links[0]?.url);
  return first ? links.filter((link) => host(link.url) === first).length : 0;
}

function host(url) {
  try { return new URL(url).hostname.replace('www.', ''); } catch { return ''; }
}

function densityStatus(value) { return value >= 0.25 && value <= 2.2 ? 'good' : value > 0 ? 'warn' : 'bad'; }
function gateStatus(status) { return status === 'pass' ? 'good' : status === 'warning' ? 'warn' : status === 'fail' ? 'bad' : 'neutral'; }
function labelFor(status) { return { good: 'Good', pass: 'Good', warn: 'Review', warning: 'Review', bad: 'Low', fail: 'High', neutral: 'N/A' }[status] || status; }
function pill(label, status) { return `<em class="status-pill ${esc(status)}">${esc(label)}</em>`; }
function countStatuses(gates) { return gates.reduce((acc, gate) => ({ ...acc, [gate.status]: (acc[gate.status] || 0) + 1 }), {}); }
function rank(status) { return { fail: 0, warning: 1, pass: 2 }[status] ?? 3; }
function row(label, current, benchmark) { return `<tr><td>${esc(label)}</td><td>${esc(current)}</td><td>${esc(benchmark)}</td><td>${pill('Benchmark', 'neutral')}</td></tr>`; }
function labelCategory(category) { return { source_intelligence: 'Source Intelligence', headline_alignment: 'Headline Alignment', narrative_diagnostics: 'Narrative Diagnostics', fluency: 'Fluency Analysis', fact_validation: 'Fact Validation', editorial_risk: 'Editorial Risk' }[category] || 'Editorial Risk'; }
function esc(value) { return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;'); }
