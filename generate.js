/**
 * 汽车配件销售日报 — 自动生成脚本
 * 运行: node generate.js
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { marked } = require('marked');

// ── 路径配置 ──────────────────────────────────────────────
const REPORTS_DIR  = path.join(__dirname, 'reports');
const INDEX_FILE   = path.join(__dirname, 'index.html');
// 优先使用仓库内的 prompts/car-daily.md（GitHub Actions 兼容）
// 回退到本地 ~/.claude/commands/car-daily.md（本地开发兼容）
const PROMPT_FILE = fs.existsSync(path.join(__dirname, 'prompts', 'car-daily.md'))
  ? path.join(__dirname, 'prompts', 'car-daily.md')
  : path.join(
      process.env.USERPROFILE || process.env.HOME || '',
      '.claude', 'commands', 'car-daily.md'
    );

// ── 初始化 ────────────────────────────────────────────────
fs.mkdirSync(REPORTS_DIR, { recursive: true });


if (!fs.existsSync(PROMPT_FILE)) {
  console.error(`❌ 找不到 Skill 文件: ${PROMPT_FILE}`);
  process.exit(1);
}

const basePrompt = fs.readFileSync(PROMPT_FILE, 'utf-8');

// ── 读取关注车型列表，拼装置顶任务 ───────────────────────
const WATCHLIST_FILE = path.join(__dirname, 'watchlist.json');
let prompt = basePrompt;
if (fs.existsSync(WATCHLIST_FILE)) {
  const { vehicles = [] } = JSON.parse(fs.readFileSync(WATCHLIST_FILE, 'utf-8'));
  if (vehicles.length) {
    const watchlistPrompt = `## 【置顶任务：最高优先级】我的关注车型速报

在所有正式章节（一、二、三…）**之前**，先输出以下速报区。搜索过程中请特别关注这些车型的最新动态：

**关注车型**：${vehicles.join(' / ')}

输出格式（使用 #### 级别标题）：

#### 🔔 我的关注 · 今日速报

| 车型 | 核心动态（≤40字） | 置信度 | 配件机会变化 |
|-----|----------------|--------|------------|
| 车型名 | 动态描述 | ✅/⚠️/❓ | ↑上升 / ↓下降 / — 持平 |

若某车型近7日确无新动态，填"近7日暂无新动态 ⚠️"。

---

`;
    prompt = watchlistPrompt + basePrompt;
  }
}

// ── 读取竞品列表，拼装竞品监控任务 ─────────────────────────
const COMPETITORS_FILE = path.join(__dirname, 'competitors.json');
if (fs.existsSync(COMPETITORS_FILE)) {
  const { brands = [] } = JSON.parse(fs.readFileSync(COMPETITORS_FILE, 'utf-8'));
  if (brands.length) {
    const competitorList = brands.map(b =>
      `- **${b.name}**（重点关注SKU：${b.focus_skus.join('、')}）`
    ).join('\n');
    prompt += `\n\n---\n\n## 【附加任务：竞品监控】\n\n请在报告末尾（六、行动建议之后）增加 **七、竞品监控** 章节，搜索以下品牌在亚马逊近7天的最新动态：\n\n${competitorList}\n\n输出格式（使用 #### 级别标题）：\n\n#### 七、竞品监控\n\n| 品牌 | 近期动态摘要（≤40字） | 价格区间变化 | 评分/评论动态 | 对我方配件业务影响 |\n|------|--------------------|------------|------------|------------------|\n\n`;
  }
}

// ── 运行 Claude CLI（异步，避免 Windows stdin 死锁）────────
console.log('🚀 正在生成日报，预计需要 3~5 分钟...\n');

const childEnv = { ...process.env };
delete childEnv.CLAUDECODE;   // 允许嵌套运行

function runClaude(input) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'claude',
      ['--print', '--output-format', 'stream-json', '--allowedTools', 'WebSearch,WebFetch', '--dangerously-skip-permissions'],
      { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] }
    );

    let lineBuffer = '';
    const allTextChunks = [];
    let stderr = '';

    child.stdout.on('data', chunk => {
      lineBuffer += chunk.toString();
      process.stdout.write('.');
      let newlineIdx;
      while ((newlineIdx = lineBuffer.indexOf('\n')) !== -1) {
        const line = lineBuffer.slice(0, newlineIdx).trim();
        lineBuffer = lineBuffer.slice(newlineIdx + 1);
        if (!line) continue;
        try {
          const event = JSON.parse(line);
          // 收集所有轮次的 assistant 文字（新版 CLI 多轮输出场景）
          if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
            for (const block of event.message.content) {
              if (block.type === 'text' && block.text) {
                allTextChunks.push(block.text);
              }
            }
          }
        } catch (_) {}
      }
    });

    child.stderr.on('data', d => { stderr += d; });

    child.on('close', code => {
      console.log('\n');
      const collected = allTextChunks.join('\n').trim();
      if (code === 0) {
        resolve(collected);
      } else {
        reject(new Error(`claude 退出码 ${code}:\nSTDERR: ${stderr}\nCOLLECTED: ${collected}`));
      }
    });
    child.on('error', err => reject(new Error(`无法启动 claude: ${err.message}`)));

    child.stdin.write(input, 'utf-8');
    child.stdin.end();

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('超时：claude 运行超过 15 分钟'));
    }, 900_000);
    child.on('close', () => clearTimeout(timer));
  });
}

// ── 主流程（async 包裹，支持 await）──────────────────────
// --rebuild 模式：仅用现有模板重建所有 HTML，不调用 Claude
if (process.argv.includes('--rebuild')) {
  const reports = fs.readdirSync(REPORTS_DIR)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.html$/.test(f)).sort();
  for (const f of reports) {
    const dateId = f.replace('.html', '');
    const dateObj = new Date(dateId + 'T12:00:00');
    const dateDisplay = dateObj.toLocaleDateString('zh-CN', {
      year: 'numeric', month: 'long', day: 'numeric', weekday: 'long'
    });
    const raw = fs.readFileSync(path.join(REPORTS_DIR, f), 'utf-8');
    const bodyMatch = raw.match(/<article class="report-body">([\s\S]*?)<\/article>/);
    if (!bodyMatch) continue;
    const newHtml = buildReportPage(bodyMatch[1], dateDisplay, dateId);
    fs.writeFileSync(path.join(REPORTS_DIR, f), newHtml, 'utf-8');
    console.log(`✅ 已重建报告: ${f}`);
  }
  buildIndexPage();
  buildSearchIndex();
  console.log(`✅ 首页已重建: ${INDEX_FILE}`);
  process.exit(0);
}

(async () => {
  let markdown;
  try {
    markdown = (await runClaude(prompt)).trim();
  } catch (err) {
    console.error('❌', err.message);
    process.exit(1);
  }
  if (!markdown) {
    console.error('❌ 生成内容为空，请检查网络连接和 API Key');
    process.exit(1);
  }

  // ── 过滤 Claude 的过程描述性文字 ──────────────────────────
  markdown = markdown
    .split('\n')
    .filter(line => {
      const t = line.trim();
      if (/^(全部|共|正在|已完成|搜索任务|整合数据|生成报告|数据整合|报告生成|以下是|根据以上|综合以上|基于以上|根据搜索|以下为您)/.test(t)) return false;
      if (/^(数据收集完毕|数据已收集|让我|开始搜索|已搜索|已完成搜索|以下是今日|以下是本期|以下报告|已完成所有)/.test(t)) return false;
      if (/个(搜索)?任务(均已|已全部|全部)/.test(t)) return false;
      if (/(搜索完成|任务完成|数据收集完成|正在整合|生成中|收集完毕|正在生成|整合完毕)/.test(t)) return false;
      return true;
    })
    .join('\n')
    .trim();

  // ── 解析日期 ────────────────────────────────────────────
  const today       = new Date();
  const dateId      = today.toISOString().split('T')[0];
  const dateDisplay = today.toLocaleDateString('zh-CN', {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long'
  });

  // ── Markdown → HTML ──────────────────────────────────────
  marked.use({ gfm: true, breaks: true });
  const bodyHtml = marked.parse(markdown);

  // ── 生成报告页 ──────────────────────────────────────────
  const reportHtml = buildReportPage(bodyHtml, dateDisplay, dateId);
  const reportFile = path.join(REPORTS_DIR, `${dateId}.html`);
  fs.writeFileSync(reportFile, reportHtml, 'utf-8');
  console.log(`✅ 日报已保存: ${reportFile}`);

  // ── 更新首页 ────────────────────────────────────────────
  buildIndexPage();
  buildSearchIndex();
  console.log(`✅ 首页已更新: ${INDEX_FILE}`);
  console.log(`\n🌐 请用浏览器打开: ${INDEX_FILE}`);
})();

// ═══════════════════════════════════════════════════════════
//  报告内容后处理：注入 Hero Banner，去除过程文字
// ═══════════════════════════════════════════════════════════
// 深度匹配，剥离所有 .report-title-hero div（无论是否带注释标记）
function stripAllHeroBanners(html) {
  // 先去掉带注释标记的整块
  html = html.replace(/<!--HERO-START-->[\s\S]*?<!--HERO-END-->\n?/g, '');
  // 再去掉遗留的裸 hero div（计数嵌套层级）
  const startTag = '<div class="report-title-hero">';
  let result = '';
  let pos = 0;
  while (true) {
    const idx = html.indexOf(startTag, pos);
    if (idx < 0) { result += html.slice(pos); break; }
    result += html.slice(pos, idx);
    let depth = 1, i = idx + startTag.length;
    while (i < html.length && depth > 0) {
      const open = html.indexOf('<div', i);
      const close = html.indexOf('</div>', i);
      if (close < 0) break;
      if (open >= 0 && open < close) { depth++; i = open + 4; }
      else { depth--; i = close + 6; }
    }
    pos = i;
  }
  return result;
}

function postProcessContent(html, dateId) {
  // 去除过程描述性段落
  html = html.replace(/<p>[^<]*(数据收集完毕|正在生成报告|收集完毕|正在整合)[^<]*<\/p>\s*/gi, '');
  html = html.replace(/^\s*<hr\s*\/?>\s*/i, '');

  // 剥离所有旧 banner（含注释标记版和裸 div 版）
  html = stripAllHeroBanners(html);

  const heroBanner = `<!--HERO-START-->
<div class="report-title-hero">
  <div class="hero-scan"></div>
  <div class="hero-corner hero-tl"></div>
  <div class="hero-corner hero-tr"></div>
  <div class="hero-corner hero-bl"></div>
  <div class="hero-corner hero-br"></div>
  <div class="hero-text-box">
    <div class="report-main-title">全球车型销售趋势与车配动态</div>
    <div class="report-title-date">[ ${dateId} ]</div>
    <div class="report-title-markets">
      <span>US 美国</span><span>EU 欧洲</span><span>MID 中东</span><span>MX 墨西哥</span><span>JP 日本</span><span>AU 澳新</span>
    </div>
  </div>
  <div class="hero-legend">
    <div class="hero-legend-title">图例说明</div>
    <div class="hero-legend-group">
      <div class="hero-legend-label">来源质量</div>
      <div><span class="legend-dot" style="background:#4ade80"></span>官方机构</div>
      <div><span class="legend-dot" style="background:#fbbf24"></span>主流媒体</div>
      <div><span class="legend-dot" style="background:#60a5fa"></span>行业媒体</div>
    </div>
    <div class="hero-legend-group">
      <div class="hero-legend-label">置信度</div>
      <div>✅ 多源验证</div>
      <div>⚠️ 单一来源</div>
      <div>❓ 来源矛盾</div>
    </div>
  </div>
</div>
<!--HERO-END-->`;

  // 新生成场景：将 h3 标题替换为 hero banner
  const replaced = html.replace(
    /<h3>📅\s*汽车配件销售参考日报[^<]*<\/h3>\s*(<hr\s*\/?>)?/i,
    heroBanner
  );

  // Rebuild 场景：h3 已不存在，直接前置 banner
  html = (replaced !== html) ? replaced : heroBanner + '\n' + html;

  // ── 服务端提取 h4 标题，注入 TOC 数据（避免客户端 DOM 文字提取的编码问题）──
  const tocSections = [];
  let h4Idx = 0;
  html = html.replace(/<h4([^>]*)>([\s\S]*?)<\/h4>/gi, (match, attrs, inner) => {
    const id = 'toc-s' + h4Idx++;
    // 剥除内嵌标签，解码常见 HTML 实体，取纯文本
    const text = inner
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ').trim();
    tocSections.push({ id, label: text.slice(0, 20) });
    const cleanAttrs = attrs.replace(/\s*id="[^"]*"/, '');
    return `<h4${cleanAttrs} id="${id}">${inner}</h4>`;
  });
  if (tocSections.length >= 2) {
    const json = JSON.stringify(tocSections).replace(/<\//g, '<\\/');
    html += `\n<script>window._tocSections=${json};</script>`;
  }

  return html.trim();
}

// ═══════════════════════════════════════════════════════════
//  生成单篇报告 HTML
// ═══════════════════════════════════════════════════════════
function buildReportPage(content, dateDisplay, dateId) {
  content = postProcessContent(content, dateId);
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>全球汽车市场动态 · ${dateDisplay}</title>
  ${sharedStyles()}
</head>
<body>
  <header class="site-header">
    <div class="header-inner">
      <div class="header-brand">
        <span class="header-icon">🚗</span>
        <div>
          <h1>全球汽车市场动态</h1>
          <p class="header-sub">跨境电商选品 · 全球市场动态 · 每日更新</p>
        </div>
      </div>
      <div class="header-meta">
        <div class="date-badge">${dateDisplay}</div>
        <a href="../index.html" class="btn-back">← 返回归档</a>
      </div>
    </div>
  </header>

  <main class="main-wrap">
    <article class="report-body">
      ${content}
    </article>
  </main>

  <footer class="site-footer">
    <p>本报告由 Claude AI 自动生成 · 数据来源于公开信息 · 仅供参考</p>
    <p>生成时间: ${new Date().toLocaleString('zh-CN')}</p>
  </footer>

  ${reportScript()}
</body>
</html>`;
}

// ═══════════════════════════════════════════════════════════
//  生成首页（归档 + 最新报告预览）
// ═══════════════════════════════════════════════════════════
function buildIndexPage() {
  const reports = fs.readdirSync(REPORTS_DIR)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.html$/.test(f))
    .sort()
    .reverse();

  const latest = reports[0] || null;
  let latestContent = '<p class="no-report">暂无报告，请先运行生成脚本。</p>';
  let latestDateDisplay = '尚未生成';

  if (latest) {
    const raw = fs.readFileSync(path.join(REPORTS_DIR, latest), 'utf-8');
    const bodyMatch = raw.match(/<article class="report-body">([\s\S]*?)<\/article>/);
    const dateMatch = raw.match(/<div class="date-badge">([^<]+)<\/div>/);
    if (bodyMatch) latestContent = postProcessContent(bodyMatch[1], latest.replace('.html', ''));
    if (dateMatch) latestDateDisplay = dateMatch[1];
  }

  const archiveLinks = reports.map((f, i) => {
    const d = f.replace('.html', '');
    const label = i === 0 ? `${d} <span class="badge-new">最新</span>` : d;
    return `<li class="${i === 0 ? 'active' : ''}">
      <a href="reports/${f}">${label}</a>
    </li>`;
  }).join('\n');

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>全球汽车市场动态 · 归档</title>
  ${sharedStyles()}
  <style>
    /* Layout */
    .index-layout { display: grid; grid-template-columns: auto 1fr; gap: 28px; align-items: start; }

    /* Sidebar shell */
    .sidebar {
      background: #fff; border-radius: 12px; box-shadow: var(--shadow);
      position: sticky; top: 20px;
      width: 220px; overflow: hidden;
      transition: width 0.26s cubic-bezier(0.4,0,0.2,1);
      flex-shrink: 0;
    }
    .sidebar.is-collapsed { width: 40px; }

    /* Toggle button (shared) */
    .sidebar-btn {
      display: flex; align-items: center; justify-content: center;
      width: 28px; height: 28px; border-radius: 50%;
      border: 1.5px solid #e2e8f0; background: #fff;
      cursor: pointer; font-size: 16px; color: #64748b;
      transition: all 0.2s; padding: 0; flex-shrink: 0; line-height: 1;
    }
    .sidebar-btn:hover { background: #f1f5f9; border-color: #94a3b8; color: #1e293b; }

    /* ── Expanded state ── */
    .sidebar-expanded-head {
      display: flex; align-items: center; justify-content: space-between;
      padding: 14px 12px 8px;
    }
    .sidebar-head-title { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: #888; font-weight: 600; white-space: nowrap; }
    .sidebar-list-wrap { padding: 4px 8px 12px; }
    .sidebar-list-wrap ul { list-style: none; margin: 0; padding: 0; }
    .sidebar-list-wrap li { border-radius: 6px; margin-bottom: 4px; }
    .sidebar-list-wrap li.active { background: var(--accent-bg); }
    .sidebar-list-wrap li.active a { color: var(--accent); font-weight: 600; }
    .sidebar-list-wrap a { display: block; padding: 7px 10px; font-size: 14px; color: #555; text-decoration: none; border-radius: 6px; }
    .sidebar-list-wrap a:hover { background: #f5f7fa; color: var(--accent); }

    /* ── Collapsed state ── */
    .sidebar-collapsed-face {
      display: none; flex-direction: column; align-items: center;
      gap: 10px; padding: 12px 0 16px; cursor: pointer;
    }
    .sidebar.is-collapsed .sidebar-collapsed-face { display: flex; }
    .sidebar.is-collapsed .sidebar-expanded-head,
    .sidebar.is-collapsed .sidebar-list-wrap { display: none; }
    .sidebar-v-text {
      writing-mode: vertical-rl; text-orientation: mixed;
      font-size: 12px; color: #64748b; font-weight: 600;
      letter-spacing: 0.14em; user-select: none;
    }

    .badge-new { background: #e74c3c; color: #fff; font-size: 11px; padding: 1px 5px; border-radius: 10px; margin-left: 4px; vertical-align: middle; }
    .no-report { color: #888; text-align: center; padding: 40px; }

    /* Search bar */
    .search-bar-wrap { margin-bottom: 20px; }
    .search-inner {
      display: flex; align-items: center; gap: 10px;
      background: #fff; border-radius: 10px; box-shadow: var(--shadow);
      padding: 10px 16px;
    }
    .search-icon { font-size: 16px; flex-shrink: 0; }
    .search-input {
      flex: 1; border: none; outline: none; font-size: 14px;
      color: #1e293b; background: transparent;
    }
    .search-count { font-size: 12px; color: #94a3b8; white-space: nowrap; }
    .search-clear {
      border: none; background: none; cursor: pointer; color: #94a3b8;
      font-size: 14px; padding: 2px 4px; border-radius: 4px;
      display: none;
    }
    .search-clear.visible { display: block; }
    .search-clear:hover { background: #f1f5f9; color: #475569; }
    /* Search results dropdown */
    .search-results {
      list-style: none; margin: 8px 0 0; padding: 0;
      background: #fff; border-radius: 10px; box-shadow: var(--shadow);
      overflow: hidden; max-height: 360px; overflow-y: auto;
    }
    .search-results li a {
      display: block; padding: 12px 18px; text-decoration: none;
      color: #1e293b; border-bottom: 1px solid #f1f5f9;
    }
    .search-results li a:hover { background: #f8fafc; }
    .search-result-date { font-size: 12px; color: var(--accent); font-weight: 600; margin-bottom: 3px; }
    .search-result-snippet { font-size: 13px; color: #475569; line-height: 1.5; }
    .search-result-snippet em { background: #fef08a; font-style: normal; border-radius: 2px; padding: 0 2px; }
    .search-no-result { padding: 16px 18px; color: #94a3b8; font-size: 14px; }
    @media (max-width: 700px) {
      .index-layout { grid-template-columns: 1fr; }
      .sidebar { position: static; width: auto !important; }
      .sidebar.is-collapsed { width: auto !important; }
      .sidebar.is-collapsed .sidebar-collapsed-face { display: none; }
      .sidebar.is-collapsed .sidebar-expanded-head,
      .sidebar.is-collapsed .sidebar-list-wrap { display: flex !important; }
      .sidebar.is-collapsed .sidebar-list-wrap { display: block !important; }
    }
  </style>
</head>
<body>
  <header class="site-header">
    <div class="header-inner">
      <div class="header-brand">
        <span class="header-icon">🚗</span>
        <div>
          <h1>全球汽车市场动态</h1>
          <p class="header-sub">跨境电商选品 · 全球市场动态 · 每日更新</p>
        </div>
      </div>
      <div class="header-meta">
        <div class="date-badge">最新: ${latestDateDisplay}</div>
      </div>
    </div>
  </header>

  <main class="main-wrap">
    <div class="search-bar-wrap">
      <div class="search-inner">
        <span class="search-icon">🔍</span>
        <input type="text" id="searchInput" class="search-input" placeholder="搜索报告内容，如「Tesla」「脚垫」「召回」…" autocomplete="off" />
        <span class="search-count" id="searchCount"></span>
        <button class="search-clear" id="searchClear" onclick="clearSearch()" title="清除搜索">✕</button>
      </div>
      <ul class="search-results" id="searchResults" hidden></ul>
    </div>
    <div class="index-layout">
      <aside class="sidebar" id="sidebar">
        <!-- 收起状态 -->
        <div class="sidebar-collapsed-face" onclick="toggleSidebar()">
          <button class="sidebar-btn" aria-label="展开归档">☰</button>
          <span class="sidebar-v-text">历史归档</span>
        </div>
        <!-- 展开状态 -->
        <div class="sidebar-expanded-head">
          <span class="sidebar-head-title">📂 历史归档</span>
          <button class="sidebar-btn" onclick="toggleSidebar()" aria-label="收起归档">‹</button>
        </div>
        <div class="sidebar-list-wrap">
          <ul>${archiveLinks || '<li><a href="#">暂无记录</a></li>'}</ul>
        </div>
      </aside>

      <article class="report-body" id="mainReport">
        ${latestContent}
      </article>
    </div>
  </main>

  <footer class="site-footer">
    <p>本报告由 Claude AI 自动生成 · 数据来源于公开信息 · 仅供参考</p>
    <p>共 ${reports.length} 份报告 · 最后更新: ${new Date().toLocaleString('zh-CN')}</p>
  </footer>

  ${reportScript()}
  <script>
    function toggleSidebar() {
      const sb = document.getElementById('sidebar');
      sb.classList.toggle('is-collapsed');
      localStorage.setItem('sbCollapsed', sb.classList.contains('is-collapsed') ? '1' : '0');
    }
    // 恢复上次状态
    if (localStorage.getItem('sbCollapsed') === '1') {
      document.getElementById('sidebar').classList.add('is-collapsed');
    }

    // ── 搜索功能 ─────────────────────────────────────────
    let searchIndex = null;
    async function loadSearchIndex() {
      if (searchIndex) return searchIndex;
      try {
        const res = await fetch('search-index.json');
        searchIndex = await res.json();
      } catch(e) { searchIndex = []; }
      return searchIndex;
    }
    function escapeRegex(s) { return s.replace(/[.+*?^\\|()\[\]-]/g, '\\\\$&'); }
    function getSnippet(text, keyword, len = 120) {
      const idx = text.toLowerCase().indexOf(keyword.toLowerCase());
      if (idx < 0) return text.slice(0, len) + '…';
      const start = Math.max(0, idx - 40);
      const raw = text.slice(start, start + len);
      const re = new RegExp('(' + escapeRegex(keyword) + ')', 'gi');
      return (start > 0 ? '…' : '') + raw.replace(re, '<em>$1</em>') + '…';
    }
    const input = document.getElementById('searchInput');
    const resultsEl = document.getElementById('searchResults');
    const countEl = document.getElementById('searchCount');
    const clearBtn = document.getElementById('searchClear');
    let debounceTimer = null;
    input.addEventListener('input', () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(doSearch, 280);
    });
    async function doSearch() {
      const q = input.value.trim();
      clearBtn.classList.toggle('visible', q.length > 0);
      if (!q) { resultsEl.hidden = true; countEl.textContent = ''; return; }
      const idx = await loadSearchIndex();
      const hits = idx.filter(r => r.text.toLowerCase().includes(q.toLowerCase()));
      countEl.textContent = hits.length ? \`找到 \${hits.length} 篇\` : '无匹配';
      if (!hits.length) {
        resultsEl.innerHTML = '<li class="search-no-result">未找到相关内容，换个关键词试试</li>';
        resultsEl.hidden = false; return;
      }
      resultsEl.innerHTML = hits.slice(0, 10).map(r =>
        \`<li><a href="\${r.url}">
          <div class="search-result-date">\${r.date}</div>
          <div class="search-result-snippet">\${getSnippet(r.text, q)}</div>
        </a></li>\`
      ).join('');
      resultsEl.hidden = false;
    }
    function clearSearch() {
      input.value = ''; resultsEl.hidden = true;
      countEl.textContent = ''; clearBtn.classList.remove('visible');
    }
    document.addEventListener('click', e => {
      if (!e.target.closest('.search-bar-wrap')) { resultsEl.hidden = true; }
    });
  </script>
</body>
</html>`;

  fs.writeFileSync(INDEX_FILE, html, 'utf-8');
}

// ═══════════════════════════════════════════════════════════
//  搜索索引生成
// ═══════════════════════════════════════════════════════════
function buildSearchIndex() {
  const reports = fs.readdirSync(REPORTS_DIR)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.html$/.test(f))
    .sort()
    .reverse();

  const index = reports.map(f => {
    const raw = fs.readFileSync(path.join(REPORTS_DIR, f), 'utf-8');
    const bodyMatch = raw.match(/<article class="report-body">([\s\S]*?)<\/article>/);
    const text = bodyMatch
      ? bodyMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      : '';
    return { date: f.replace('.html', ''), url: `reports/${f}`, text };
  });

  const indexFile = path.join(__dirname, 'search-index.json');
  fs.writeFileSync(indexFile, JSON.stringify(index), 'utf-8');
  console.log(`✅ 搜索索引已更新: ${indexFile}`);
}

// ═══════════════════════════════════════════════════════════
//  共享 CSS
// ═══════════════════════════════════════════════════════════
function sharedStyles() {
  return `<style>
    :root {
      --accent: #2563eb;
      --accent-bg: #eff6ff;
      --header-from: #0f172a;
      --header-to: #1e3a5f;
      --shadow: 0 1px 4px rgba(0,0,0,.08), 0 4px 16px rgba(0,0,0,.06);
      --radius: 12px;
    }
    *, *::before, *::after { box-sizing: border-box; }
    body { margin: 0; font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
           background: #f1f5f9; color: #1e293b; line-height: 1.7; font-size: 15px; }

    /* Header */
    .site-header { background: linear-gradient(135deg, var(--header-from), var(--header-to));
                   color: #fff; padding: 20px 0; }
    .header-inner { max-width: 1600px; margin: 0 auto; padding: 0 32px;
                    display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; }
    .header-brand { display: flex; align-items: center; gap: 14px; }
    .header-icon { font-size: 36px; }
    .header-brand h1 { margin: 0; font-size: 22px; font-weight: 700; }
    .header-sub { margin: 2px 0 0; font-size: 13px; opacity: .75; }
    .header-meta { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
    .date-badge { background: rgba(255,255,255,.15); border: 1px solid rgba(255,255,255,.25);
                  padding: 5px 14px; border-radius: 20px; font-size: 13px; }
    .btn-back { background: rgba(255,255,255,.15); border: 1px solid rgba(255,255,255,.25);
                color: #fff; text-decoration: none; padding: 5px 14px; border-radius: 20px;
                font-size: 13px; transition: background .2s; }
    .btn-back:hover { background: rgba(255,255,255,.25); }

    /* Layout */
    .main-wrap { max-width: 1600px; margin: 28px auto; padding: 0 32px 40px; }

    /* Report body */
    .report-body { background: #fff; border-radius: var(--radius); box-shadow: var(--shadow); padding: 36px 40px; }
    .report-body h1 { font-size: 22px; color: #0f172a; border-bottom: 2px solid #e2e8f0; padding-bottom: 10px; margin-top: 0; }
    .report-body h2 { font-size: 18px; color: #1e3a5f; margin-top: 36px; padding: 8px 14px;
                      background: #f8fafc; border-left: 4px solid var(--accent); border-radius: 0 6px 6px 0; }
    .report-body h3 { font-size: 15px; color: #334155; margin-top: 24px; }
    .report-body h4 { font-size: 14px; color: #475569; margin-top: 18px; }
    .report-body p { margin: 10px 0; }
    .report-body a { color: var(--accent); }
    .report-body strong { color: #0f172a; }
    .report-body hr { border: none; border-top: 1px solid #e2e8f0; margin: 28px 0; }
    .report-body blockquote { margin: 12px 0; padding: 10px 16px; background: #f8fafc;
                               border-left: 3px solid #cbd5e1; border-radius: 0 6px 6px 0; color: #475569; }

    /* Tables */
    .report-body table { width: 100%; border-collapse: collapse; margin: 16px 0; font-size: 14px; }
    .report-body th { background: #1e3a5f; color: #fff; padding: 10px 14px; text-align: left; font-weight: 600; }
    .report-body td { padding: 9px 14px; border-bottom: 1px solid #e2e8f0; vertical-align: top; }
    .report-body tr:hover td { background: #f8fafc; }
    .report-body tr:nth-child(even) td { background: #fafafa; }
    .report-body tr:nth-child(even):hover td { background: #f1f5f9; }

    /* Lists */
    .report-body ul, .report-body ol { padding-left: 22px; }
    .report-body li { margin: 5px 0; }

    /* Code */
    .report-body code { background: #f1f5f9; padding: 1px 5px; border-radius: 4px; font-size: 13px; }

    /* Footer */
    .site-footer { text-align: center; padding: 20px; font-size: 12px; color: #94a3b8; }

    /* Star ratings → colored */
    .report-body td:last-child, .report-body td { white-space: pre-line; }

    /* === Report Hero Banner — Photo Sci-Fi === */
    .report-title-hero {
      height: 300px;
      margin: -36px -40px 40px;
      border-radius: var(--radius) var(--radius) 0 0;
      position: relative; overflow: hidden; color: #fff;
      background:
        url('https://images.unsplash.com/photo-1617788138017-80ad40651399?w=1600&q=85&fit=crop&crop=center')
        center/cover no-repeat,
        linear-gradient(135deg, #020c1b, #0c1e3c);
    }
    /* Composite overlay: strong dark on left+bottom, keep right luminous */
    .report-title-hero::before {
      content: '';
      position: absolute; inset: 0; z-index: 1;
      background:
        linear-gradient(to right,  rgba(0,5,15,.92) 0%, rgba(0,5,15,.65) 42%, rgba(0,5,15,.15) 100%),
        linear-gradient(to top,    rgba(0,5,15,.90) 0%, rgba(0,5,15,.4)  45%, transparent 75%);
    }
    /* Top neon border */
    .report-title-hero::after {
      content: '';
      position: absolute; top: 0; left: 0; right: 0; height: 2px;
      background: linear-gradient(90deg, #00e5ff 0%, #3b82f6 40%, #7c3aed 60%, transparent 100%);
      opacity: .9;
    }
    /* Scan line */
    @keyframes heroScan {
      0%   { top: -1px; opacity: 0; }
      5%   { opacity: .7; }
      90%  { opacity: .3; }
      100% { top: 100%; opacity: 0; }
    }
    .hero-scan {
      position: absolute; left: 0; right: 0; height: 1px; top: 0;
      background: linear-gradient(90deg, rgba(0,229,255,.8) 0%, rgba(0,229,255,.4) 50%, transparent 100%);
      animation: heroScan 6s ease-in-out infinite;
      z-index: 3; pointer-events: none;
    }
    /* HUD corner brackets */
    .hero-corner { position: absolute; width: 20px; height: 20px; z-index: 2; }
    .hero-tl { top: 12px; left: 12px; border-top: 2px solid rgba(0,229,255,.8); border-left: 2px solid rgba(0,229,255,.8); }
    .hero-tr { top: 12px; right: 12px; border-top: 2px solid rgba(0,229,255,.5); border-right: 2px solid rgba(0,229,255,.5); }
    .hero-bl { bottom: 12px; left: 12px; border-bottom: 2px solid rgba(0,229,255,.8); border-left: 2px solid rgba(0,229,255,.8); }
    .hero-br { bottom: 12px; right: 12px; border-bottom: 2px solid rgba(0,229,255,.5); border-right: 2px solid rgba(0,229,255,.5); }
    /* Text block — bottom-left */
    .hero-text-box {
      position: absolute; bottom: 32px; left: 40px;
      z-index: 2; text-align: left; max-width: 58%;
    }
    /* Main title — div, not h1, avoids .report-body h1 cascade */
    .report-main-title {
      font-size: 28px; font-weight: 900; color: #ffffff;
      letter-spacing: .04em; margin: 0 0 10px; line-height: 1.3;
      text-shadow:
        0 0 12px rgba(0,229,255,.9),
        0 0 32px rgba(0,229,255,.5),
        0 2px 4px rgba(0,0,0,1),
        0 4px 12px rgba(0,0,0,1);
    }
    .report-title-date {
      font-size: 12px; color: rgba(0,229,255,.9); margin-bottom: 16px;
      font-family: 'Courier New', monospace; letter-spacing: .12em;
    }
    .report-title-markets {
      display: flex; flex-wrap: wrap; gap: 5px 7px;
    }
    .report-title-markets span {
      background: rgba(0,0,0,.5); backdrop-filter: blur(8px);
      border: 1px solid rgba(255,255,255,.2);
      color: rgba(255,255,255,.9);
      padding: 4px 10px; border-radius: 20px;
      font-size: 12px; font-weight: 500;
      font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
    }

    /* === 我的关注 watchlist 区 === */
    .watchlist-section {
      margin-bottom: 8px;
    }
    .watchlist-section h4 {
      background: linear-gradient(90deg, #fffbeb, #fef9ee) !important;
      border-left: 4px solid #f59e0b !important;
      color: #78350f !important;
    }
    .watchlist-section table th {
      background: #92400e !important;
    }
    .watchlist-section table tr:nth-child(even) td { background: #fffbeb !important; }
    .watchlist-section table tr:hover td { background: #fef3c7 !important; }

    /* === 来源质量标签 === */
    .src-official  { color: #16a34a; font-weight: 700; font-size: 12px; }
    .src-media     { color: #ca8a04; font-weight: 700; font-size: 12px; }
    .src-industry  { color: #2563eb; font-weight: 700; font-size: 12px; }

    /* === 置信度标记 === */
    .conf-verified  { color: #16a34a; }
    .conf-single    { color: #ca8a04; }
    .conf-conflict  { color: #dc2626; }

    /* Enhanced section headers */
    .report-body h4 {
      font-size: 16px; color: #1a3869; margin-top: 36px;
      padding: 10px 18px; background: linear-gradient(90deg, #eff6ff, #f8fafc);
      border-left: 4px solid #2563eb; border-radius: 0 8px 8px 0;
      box-shadow: 0 1px 4px rgba(37,99,235,0.08);
    }

    /* === Hero legend (bottom-right) === */
    .hero-legend {
      position: absolute; bottom: 28px; right: 36px;
      z-index: 2; text-align: right;
      background: rgba(0,0,0,.45); backdrop-filter: blur(8px);
      border: 1px solid rgba(255,255,255,.12);
      border-radius: 8px; padding: 10px 14px;
      display: flex; gap: 16px;
    }
    .hero-legend-title {
      display: none; /* 两列并排，不需要总标题 */
    }
    .hero-legend-group {
      display: flex; flex-direction: column; gap: 4px;
      font-size: 11px; color: rgba(255,255,255,.75);
      line-height: 1.5;
    }
    .hero-legend-label {
      font-size: 10px; font-weight: 700; letter-spacing: .08em;
      color: rgba(255,255,255,.45); text-transform: uppercase; margin-bottom: 2px;
    }
    .legend-dot {
      display: inline-block; width: 8px; height: 8px;
      border-radius: 50%; margin-right: 5px; vertical-align: middle;
    }

    /* === 配件机会热力图 === */
    .heat-3 { background: #dcfce7 !important; color: #14532d !important; font-weight: 700; }
    .heat-2 { background: #fef9c3 !important; color: #713f12 !important; font-weight: 600; }
    .heat-1 { background: #fff7ed !important; color: #9a3412 !important; }
    .heat-0 { background: #f8fafc !important; color: #94a3b8 !important; }

    /* === 竞品监控区 === */
    .competitor-section h4 {
      background: linear-gradient(90deg, #fdf2f8, #faf5ff) !important;
      border-left: 4px solid #a855f7 !important;
      color: #581c87 !important;
    }
    .competitor-section table th { background: #6b21a8 !important; }
    .competitor-section table tr:nth-child(even) td { background: #fdf4ff !important; }
    .competitor-section table tr:hover td { background: #fae8ff !important; }

    /* === 章节快速跳转 TOC === */
    .toc-panel {
      position: fixed; right: 16px; top: 50%;
      transform: translateY(-50%);
      z-index: 200;
      background: rgba(255,255,255,0.94);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      border: 1px solid rgba(226,232,240,0.8);
      border-radius: 24px; padding: 10px 7px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.10);
      display: flex; flex-direction: column; gap: 2px;
      max-width: 34px; overflow: hidden;
      transition: max-width 0.22s cubic-bezier(0.4,0,0.2,1),
                  border-radius 0.22s, padding 0.22s;
    }
    .toc-panel:hover { max-width: 210px; border-radius: 12px; padding: 10px 14px; }
    .toc-item {
      display: flex; align-items: center; gap: 9px;
      cursor: pointer; padding: 4px 0;
      color: #94a3b8; transition: color 0.18s; white-space: nowrap;
    }
    .toc-item:hover, .toc-item.active { color: var(--accent); }
    .toc-dot {
      width: 8px; height: 8px; border-radius: 50%;
      background: #cbd5e1; flex-shrink: 0;
      transition: background 0.18s, transform 0.18s;
    }
    .toc-item.active .toc-dot { background: var(--accent); transform: scale(1.5); }
    .toc-label {
      font-size: 12px; font-weight: 500; opacity: 0;
      overflow: hidden; text-overflow: ellipsis; max-width: 160px;
      transition: opacity 0.18s;
    }
    .toc-panel:hover .toc-label { opacity: 1; }
    .report-body h4 { scroll-margin-top: 80px; }
    @media (max-width: 1100px) { .toc-panel { display: none; } }

    @media (max-width: 700px) {
      .report-body { padding: 20px 16px; }
      .report-body table { font-size: 12px; }
      .report-body th, .report-body td { padding: 7px 9px; }
      .header-brand h1 { font-size: 17px; }
      .report-title-hero { height: 220px; margin: -20px -16px 24px; }
      .hero-text-box { left: 20px; bottom: 18px; max-width: 65%; }
      .report-main-title { font-size: 18px !important; }
      .hero-legend { right: 16px; bottom: 18px; padding: 8px 10px; gap: 10px; }
      .hero-legend-group { font-size: 10px; }
    }
    @media print {
      .site-header { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .btn-back, .sidebar { display: none; }
    }
  </style>`;
}

// ═══════════════════════════════════════════════════════════
//  共享 JS（高亮星级评分）
// ═══════════════════════════════════════════════════════════
function reportScript() {
  return `<script>
    // 星级评分 & 正负面标记
    document.querySelectorAll('td').forEach(td => {
      if (td.textContent.includes('⭐⭐⭐')) td.style.color = '#16a34a';
      else if (td.textContent.includes('⭐⭐')) td.style.color = '#ca8a04';
      if (td.textContent.startsWith('✅')) td.style.background = '#f0fdf4';
      if (td.textContent.startsWith('❌')) td.style.background = '#fef2f2';
      if (td.textContent.startsWith('➖')) td.style.background = '#fafafa';
    });

    // 🔔 我的关注 — 高亮整个 section
    document.querySelectorAll('h4').forEach(h4 => {
      if (!h4.textContent.includes('🔔')) return;
      const wrapper = document.createElement('div');
      wrapper.className = 'watchlist-section';
      let el = h4.nextElementSibling;
      const siblings = [];
      while (el && el.tagName !== 'H4') { siblings.push(el); el = el.nextElementSibling; }
      h4.parentNode.insertBefore(wrapper, h4);
      wrapper.appendChild(h4);
      siblings.forEach(s => wrapper.appendChild(s));
    });

    // 配件机会热力图着色（检测 🔥 符号）
    document.querySelectorAll('.report-body td').forEach(td => {
      const t = td.textContent.trim();
      if (t.includes('🔥🔥🔥'))      td.classList.add('heat-3');
      else if (t.includes('🔥🔥'))   td.classList.add('heat-2');
      else if (t.startsWith('🔥'))   td.classList.add('heat-1');
      else if (t === '—' && td.closest('table') && td.closest('table').textContent.includes('🔥')) td.classList.add('heat-0');
    });

    // 竞品监控区高亮
    document.querySelectorAll('h4').forEach(h4 => {
      if (!h4.textContent.includes('竞品监控')) return;
      const wrapper = document.createElement('div');
      wrapper.className = 'competitor-section';
      let el = h4.nextElementSibling;
      const siblings = [];
      while (el && el.tagName !== 'H4') { siblings.push(el); el = el.nextElementSibling; }
      h4.parentNode.insertBefore(wrapper, h4);
      wrapper.appendChild(h4);
      siblings.forEach(s => wrapper.appendChild(s));
    });

    // 章节快速跳转 TOC（数据由服务端注入 window._tocSections，避免客户端编码问题）
    (function buildTOC() {
      var sections = window._tocSections;
      if (!sections || sections.length < 2) return;
      var panel = document.createElement('div');
      panel.className = 'toc-panel';
      sections.forEach(function(sec) {
        var item = document.createElement('div');
        item.className = 'toc-item';
        item.setAttribute('data-id', sec.id);
        item.addEventListener('click', function() {
          var el = document.getElementById(sec.id);
          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
        var dot = document.createElement('span');
        dot.className = 'toc-dot';
        var lbl = document.createElement('span');
        lbl.className = 'toc-label';
        lbl.textContent = sec.label;
        item.appendChild(dot);
        item.appendChild(lbl);
        panel.appendChild(item);
      });
      document.body.appendChild(panel);
      var items = panel.querySelectorAll('.toc-item');
      var obs = new IntersectionObserver(function(entries) {
        entries.forEach(function(e) {
          if (e.isIntersecting) {
            var id = e.target.id;
            items.forEach(function(it) {
              it.classList.toggle('active', it.getAttribute('data-id') === id);
            });
          }
        });
      }, { rootMargin: '-10% 0px -80% 0px', threshold: 0 });
      sections.forEach(function(sec) {
        var el = document.getElementById(sec.id);
        if (el) obs.observe(el);
      });
    })();

    // 来源质量标签着色
    document.querySelectorAll('a').forEach(a => {
      const prev = a.previousSibling;
      if (!prev || prev.nodeType !== 3) return;
      const t = prev.textContent;
      if (t.includes('🟢【官方】'))   { const s = document.createElement('span'); s.className='src-official'; s.textContent='🟢 官方'; a.parentNode.insertBefore(s,a); prev.textContent=prev.textContent.replace(/🟢【官方】\s*/,''); }
      else if (t.includes('🟡【媒体】')) { const s = document.createElement('span'); s.className='src-media';    s.textContent='🟡 媒体'; a.parentNode.insertBefore(s,a); prev.textContent=prev.textContent.replace(/🟡【媒体】\s*/,''); }
      else if (t.includes('🔵【行业】')) { const s = document.createElement('span'); s.className='src-industry'; s.textContent='🔵 行业'; a.parentNode.insertBefore(s,a); prev.textContent=prev.textContent.replace(/🔵【行业】\s*/,''); }
    });
  </script>`;
}
