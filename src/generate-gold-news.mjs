import Parser from "rss-parser";
import axios from "axios";
import { chromium } from "playwright";

// 環境変数の取得
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const WIX_API_KEY = process.env.WIX_API_KEY;
const WIX_SITE_ID = process.env.WIX_SITE_ID;
const WIX_CATEGORY_ID = process.env.WIX_CATEGORY_ID; // 共通カテゴリ
const WIX_GOLD_CATEGORY_ID = process.env.WIX_GOLD_CATEGORY_ID; // ゴールド専用カテゴリ
const WIX_MEMBER_ID = process.env.WIX_MEMBER_ID;
const POST_STATUS = process.env.POST_STATUS || "draft"; // 'publish' または 'draft'

// Wix API呼び出しの共通タイムアウト（ジョブハング防止）
const WIX_API_TIMEOUT = 30000;

const parser = new Parser({
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Accept: "application/rss+xml, application/xml, text/xml, */*",
  },
  timeout: 10000,
});

// TradingView公式ウィジェット（HTMLページ。Playwrightで実際にレンダリングしてスクリーンショットする）
const CHART_WIDGET_URL =
  "https://s.tradingview.com/widgetembed/?symbol=OANDA%3AXAUUSD&interval=D&theme=light&style=1&timezone=Asia%2FTokyo&withdateranges=1";
const CHART_WIDTH = 900;
const CHART_HEIGHT = 500;

// 1. ゴールド相場の実データ取得（無料API / キー不要）
async function fetchGoldMarketData() {
  const marketData = {
    xauUsd: null,
    xauPrevClose: null,
    usdJpy: null,
  };

  // XAU/USD 現在値（gold-api.com）
  try {
    console.log("金スポット価格 (XAU/USD) 取得中...");
    const res = await axios.get("https://api.gold-api.com/price/XAU", { timeout: 10000 });
    marketData.xauUsd = res.data?.price ?? null;
    marketData.xauPrevClose = res.data?.prev_close_price ?? null;
    console.log(`  XAU/USD: ${marketData.xauUsd} (前日終値: ${marketData.xauPrevClose})`);
  } catch (e) {
    console.warn(`金価格API取得スキップ: ${e.message}`);
  }

  // USD/JPY（frankfurter.app）
  try {
    console.log("ドル円レート取得中...");
    const res = await axios.get("https://api.frankfurter.app/latest?from=USD&to=JPY", { timeout: 10000 });
    marketData.usdJpy = res.data?.rates?.JPY ?? null;
    console.log(`  USD/JPY: ${marketData.usdJpy}`);
  } catch (e) {
    console.warn(`為替API取得スキップ: ${e.message}`);
  }

  return marketData;
}

// 2. ゴールド関連ニュースの収集
// 各ソースは公式RSSを優先し、公式RSSがない/失敗した場合はGoogle Newsのサイト限定検索にフォールバック
async function fetchGoldNews() {
  const rssSources = [
    {
      name: "KITCO News",
      url: "https://www.kitco.com/rss/",
      fallback: "https://news.google.com/rss/search?q=gold+site%3Akitco.com&hl=en-US&gl=US&ceid=US:en",
      limit: 4,
    },
    {
      name: "Goldhub (World Gold Council)",
      url: "https://www.gold.org/feed",
      fallback: "https://news.google.com/rss/search?q=gold+site%3Agold.org&hl=en-US&gl=US&ceid=US:en",
      limit: 3,
    },
    {
      name: "GoldSeek.com",
      url: "https://news.goldseek.com/feed",
      fallback: "https://news.google.com/rss/search?q=gold+site%3Agoldseek.com&hl=en-US&gl=US&ceid=US:en",
      limit: 4,
    },
    {
      name: "Yahoo!ニュース（経済）",
      url: "https://news.yahoo.co.jp/rss/topics/business.xml",
      fallback: null,
      limit: 4,
    },
    {
      name: "Reuters（コモディティ）",
      // Reutersは公式RSSを廃止済みのためGoogle Newsのサイト限定検索を使用
      url: "https://news.google.com/rss/search?q=gold+OR+commodities+site%3Areuters.com&hl=en-US&gl=US&ceid=US:en",
      fallback: null,
      limit: 4,
    },
    {
      name: "Trading Economics",
      url: "https://news.google.com/rss/search?q=gold+site%3Atradingeconomics.com&hl=en-US&gl=US&ceid=US:en",
      fallback: null,
      limit: 3,
    },
  ];

  const allHeadlines = [];

  const parseFeed = async (url, sourceName, limit) => {
    console.log(`RSS取得中: [${sourceName}] ${url}`);
    const feed = await parser.parseURL(url);
    if (feed && feed.items && feed.items.length > 0) {
      const top = feed.items.slice(0, limit).map((item) => {
        return `- 【${sourceName}】${item.title}\n  概要: ${item.contentSnippet || item.content || "速報"}\n  URL: ${item.link}`;
      });
      allHeadlines.push(...top);
      return true;
    }
    return false;
  };

  for (const source of rssSources) {
    try {
      const ok = await parseFeed(source.url, source.name, source.limit);
      if (!ok && source.fallback) {
        console.warn(`[${source.name}] 公式RSSに記事なし。Google News検索にフォールバックします。`);
        await parseFeed(source.fallback, source.name, source.limit);
      }
    } catch (e) {
      console.warn(`[${source.name}] RSS取得失敗: ${e.message}`);
      if (source.fallback) {
        try {
          await parseFeed(source.fallback, source.name, source.limit);
        } catch (fallbackErr) {
          console.warn(`[${source.name}] フォールバックも失敗: ${fallbackErr.message}`);
        }
      }
    }
  }

  if (allHeadlines.length === 0) {
    throw new Error("すべてのニュースソースからの取得に失敗しました。");
  }

  return allHeadlines.join("\n\n");
}

// 3. Gemini APIによる高品質レポート生成（Flash系モデル自動フォールバック）
async function generateArticleWithGemini(prompt) {
  const priorityOrder = [
    "models/gemini-3.7-flash",
    "models/gemini-3.5-flash",
    "models/gemini-3.6-flash",
    "models/gemini-flash-latest",
    "models/gemini-3.1-flash-lite",
  ];

  const systemInstruction = `あなたは金融情報メディア「投資の種」の貴金属担当シニアアナリストです。
毎朝、ゴールド（金）投資家向けに配信される「ゴールド朝報」を【日本語】で作成してください。
地金・純金積立を行う個人投資家と、ドル建て金（XAU/USD）で取引するFX・CFDトレーダーの両方に有益な内容にしてください。
思考プロセスや英語の解説、マークダウンのコードブロック（\`\`\`markdown 等）は一切出力せず、指定された構成の【日本語の記事本文のみ】を出力してください。
提供された実データ（金スポット価格・為替）と矛盾する数値を絶対に生成しないでください。数値が不明な場合は創作せず「データ取得不可」と記載してください。`;

  for (const modelName of priorityOrder) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        console.log(`記事生成を試行中: ${modelName} (試行: ${attempt}/2)`);
        const generateUrl = `https://generativelanguage.googleapis.com/v1beta/${modelName}:generateContent?key=${GEMINI_API_KEY}`;

        const genRes = await axios.post(
          generateUrl,
          {
            systemInstruction: {
              parts: [{ text: systemInstruction }],
            },
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0.3,
            },
          },
          {
            headers: { "Content-Type": "application/json" },
            timeout: 45000,
          }
        );

        const text = genRes.data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text && text.trim().length > 0) {
          console.log(`モデル [${modelName}] で高品質記事の生成に成功しました！`);
          return text;
        }
      } catch (err) {
        const errMsg = err.response?.data?.error?.message || err.message;
        console.warn(`モデル [${modelName}] 試行${attempt} エラー: ${errMsg}`);

        if (errMsg.includes("high demand") || errMsg.includes("503")) {
          console.log("混雑のため2秒待機して再試行します...");
          await new Promise((resolve) => setTimeout(resolve, 2000));
        } else {
          break;
        }
      }
    }
  }

  throw new Error("利用可能なGeminiモデルでの記事生成に失敗しました。");
}

// 4. インライン装飾（太字 **text**）のパース処理
function parseInlines(text) {
  const parts = text.split(/(\*\*.*?\*\*)/g);
  const inlineNodes = [];

  for (const part of parts) {
    if (!part) continue;
    if (part.startsWith("**") && part.endsWith("**") && part.length >= 4) {
      inlineNodes.push({
        type: "TEXT",
        textData: {
          text: part.slice(2, -2),
          decorations: [{ type: "BOLD" }],
        },
      });
    } else {
      inlineNodes.push({
        type: "TEXT",
        textData: {
          text: part,
          decorations: [],
        },
      });
    }
  }

  return inlineNodes.length > 0 ? inlineNodes : [{ type: "TEXT", textData: { text, decorations: [] } }];
}

// 5. 空白行（空の段落ノード）の生成ヘルパー
function createEmptyLineNode() {
  return {
    type: "PARAGRAPH",
    nodes: [{ type: "TEXT", textData: { text: "", decorations: [] } }],
  };
}

// 5b. 画像ノードの生成ヘルパー（Wixメディアマネージャーにアップロード済みの画像を埋め込む）
// Wix公式スキーマ: imageData.image は Media 型。src.id にはファイルIDのみ（フルURIではない）を指定
function createImageNode(mediaId, staticUrl, altText, width, height) {
  return {
    type: "IMAGE",
    imageData: {
      containerData: { alignment: "CENTER", width: { size: "CONTENT" } },
      image: {
        // FileSource: id にはファイルID（例: 4a9a75_xxx~mv2.png）のみを指定
        src: { id: mediaId, url: staticUrl },
        width: width,
        height: height,
      },
      altText: altText,
    },
  };
}

// 5c. プレーンテキスト段落の生成ヘルパー（チャート失敗時のフォールバック用）
function createTextParagraph(text) {
  return {
    type: "PARAGRAPH",
    nodes: [{ type: "TEXT", textData: { text, decorations: [] } }],
  };
}

// 5d. PlaywrightでTradingViewウィジェットを実レンダリングしてスクリーンショット取得
async function captureGoldChart() {
  let browser = null;
  try {
    console.log("TradingViewチャートのスクリーンショット取得中...");
    browser = await chromium.launch();
    const page = await browser.newPage({
      viewport: { width: CHART_WIDTH, height: CHART_HEIGHT },
    });
    await page.goto(CHART_WIDGET_URL, { waitUntil: "networkidle", timeout: 45000 });
    // チャート描画待機
    await page.waitForTimeout(4000);
    const buffer = await page.screenshot({ type: "png" });
    console.log(`チャート画像取得完了（${buffer.length} bytes）`);
    return buffer;
  } catch (e) {
    console.warn(`チャート画像の取得に失敗しました: ${e.message}`);
    return null;
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (e) {}
    }
  }
}

// 5e. Wixメディアマネージャーへ画像をアップロードし、wix:image://v1/... URIを取得
// アップロード直後はファイルが処理中（PENDING）のため、READYになるまでポーリングしてからURIを返す
async function uploadImageToWix(pngBuffer, fileName) {
  const headers = {
    Authorization: WIX_API_KEY,
    "wix-site-id": WIX_SITE_ID,
    "Content-Type": "application/json",
  };

  // 1. アップロードURLの発行
  const genRes = await axios.post(
    "https://www.wixapis.com/site-media/v1/files/generate-upload-url",
    {
      mimeType: "image/png",
      fileName: fileName,
      private: false,
      sizeInBytes: String(pngBuffer.length),
    },
    { headers, timeout: WIX_API_TIMEOUT }
  );
  const uploadUrl = genRes.data?.uploadUrl;
  if (!uploadUrl) {
    throw new Error("WixメディアのアップロードURL発行に失敗しました。");
  }

  // 2. バイナリをアップロード（filenameクエリパラメータ付与）
  const uploadUrlWithName = uploadUrl.includes("?")
    ? `${uploadUrl}&filename=${encodeURIComponent(fileName)}`
    : `${uploadUrl}?filename=${encodeURIComponent(fileName)}`;
  const upRes = await axios.put(uploadUrlWithName, pngBuffer, {
    headers: { "Content-Type": "image/png" },
    timeout: 60000,
    maxBodyLength: Infinity,
  });
  const file = upRes.data?.file;
  // レスポンス例: file.id = "4a9a75_xxx~mv2.png"
  const mediaId = file?.id || file?.url?.match(/\/media\/([^/]+)$/)?.[1];
  let staticUrl = file?.url || null;
  if (!mediaId) {
    console.warn("Wixメディアのアップロードレスポンス:", JSON.stringify(upRes.data));
    throw new Error("Wixメディアへのアップロード結果からメディアIDを取得できませんでした。");
  }
  console.log(`Wixメディアアップロード受理（処理中）: ${mediaId} / status=${file?.operationStatus || "不明"}`);

  // 3. ファイルが READY になるまでポーリング（最大30秒・2秒間隔）
  //    アップロード直後は処理中のため、READY前に記事へ挿入すると画像が空白表示になる
  const maxAttempts = 15;
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      const descRes = await axios.get(
        `https://www.wixapis.com/site-media/v1/files/${encodeURIComponent(mediaId)}`,
        { headers, timeout: WIX_API_TIMEOUT }
      );
      const descFile = descRes.data?.file;
      const status = descFile?.operationStatus;
      // descriptorから最新のURLも取得しておく
      if (descFile?.url) staticUrl = descFile.url;
      if (status === "READY") {
        console.log(`ファイル処理完了（READY）: ${mediaId}（${i}回目で確認）`);
        break;
      }
      if (status === "FAILED") {
        throw new Error(`Wixメディアのファイル処理に失敗しました: ${mediaId}`);
      }
      if (i === maxAttempts) {
        console.warn(`READY確認がタイムアウトしました（${maxAttempts}回）。処理中のまま続行します。`);
      } else {
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    } catch (pollErr) {
      if (pollErr.message.includes("ファイル処理に失敗")) throw pollErr;
      if (i === maxAttempts) {
        console.warn(`READY確認ポーリングでエラー: ${pollErr.message}。処理中のまま続行します。`);
      } else {
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }

  // Ricos参照に必要な情報を返す（ファイルID と 静的URL の両方）
  console.log(`Wixメディアへのアップロード完了: id=${mediaId} / url=${staticUrl || "未取得"}`);
  return { mediaId, staticUrl };
}

// 6. MarkdownをWix RichContentに変換（セクション・見出し間の余白制御）
function parseMarkdownToWixNodes(mdText) {
  const lines = mdText.split("\n");
  const nodes = [];
  let currentBulletList = [];

  const addNodeWithSpacing = (node, needTopSpacing = false) => {
    if (needTopSpacing && nodes.length > 0) {
      const lastNode = nodes[nodes.length - 1];
      const isLastEmpty =
        lastNode.type === "PARAGRAPH" &&
        lastNode.nodes?.[0]?.textData?.text === "";
      if (!isLastEmpty) {
        nodes.push(createEmptyLineNode());
      }
    }
    nodes.push(node);
  };

  const flushBulletList = () => {
    if (currentBulletList.length > 0) {
      const listItems = currentBulletList.map((itemText) => ({
        type: "LIST_ITEM",
        nodes: [
          {
            type: "PARAGRAPH",
            nodes: parseInlines(itemText),
          },
        ],
      }));
      nodes.push({
        type: "BULLETED_LIST",
        nodes: listItems,
      });
      currentBulletList = [];
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      flushBulletList();
      continue;
    }

    if (trimmed.startsWith("## ")) {
      flushBulletList();
      addNodeWithSpacing(
        {
          type: "HEADING",
          headingData: { level: 2 },
          nodes: parseInlines(trimmed.slice(3).trim()),
        },
        true
      );
      nodes.push(createEmptyLineNode());
    } else if (trimmed.startsWith("### ")) {
      flushBulletList();
      addNodeWithSpacing(
        {
          type: "HEADING",
          headingData: { level: 3 },
          nodes: parseInlines(trimmed.slice(4).trim()),
        },
        true
      );
    } else if (trimmed === "---" || trimmed === "***" || trimmed === "___") {
      flushBulletList();
      addNodeWithSpacing(
        {
          type: "DIVIDER",
          dividerData: { lineStyle: "SINGLE", width: "LARGE", alignment: "CENTER" },
        },
        true
      );
      nodes.push(createEmptyLineNode());
    } else if (trimmed.startsWith("* ") || trimmed.startsWith("- ")) {
      currentBulletList.push(trimmed.slice(2).trim());
    } else {
      flushBulletList();
      addNodeWithSpacing(
        {
          type: "PARAGRAPH",
          nodes: parseInlines(trimmed),
        },
        false
      );
    }
  }

  flushBulletList();
  return nodes;
}

// 7. Wix APIから有効な memberId を確実に取得
async function getWixMemberId() {
  const headers = {
    Authorization: WIX_API_KEY,
    "wix-site-id": WIX_SITE_ID,
  };

  try {
    const res = await axios.get("https://www.wixapis.com/blog/v3/draft-posts?paging.limit=10", {
      headers,
      timeout: WIX_API_TIMEOUT,
    });
    const drafts = res.data.draftPosts || [];
    for (const d of drafts) {
      if (d.memberId) return d.memberId;
    }
  } catch (e) {}

  try {
    const res = await axios.get("https://www.wixapis.com/blog/v3/posts?paging.limit=10", {
      headers,
      timeout: WIX_API_TIMEOUT,
    });
    const posts = res.data.posts || [];
    for (const p of posts) {
      if (p.memberId) return p.memberId;
    }
  } catch (e) {}

  try {
    const res = await axios.get("https://www.wixapis.com/members/v1/members?paging.limit=10", {
      headers,
      timeout: WIX_API_TIMEOUT,
    });
    const members = res.data.members || [];
    if (members.length > 0 && members[0].id) return members[0].id;
  } catch (e) {}

  if (WIX_MEMBER_ID && WIX_MEMBER_ID.trim().length > 0) {
    return WIX_MEMBER_ID.trim();
  }

  throw new Error("WixのmemberIdを検出できませんでした。");
}

async function runPipeline() {
  console.log(`【設定】投稿モード: ${POST_STATUS.toUpperCase()}`);
  console.log("【1/4】ゴールド市場データ・関連ニュース収集開始...");

  const marketData = await fetchGoldMarketData();
  const newsContext = await fetchGoldNews();

  // 前日比（変動率）の計算
  let prevCloseStr = "データ取得不可";
  let changeStr = "データ取得不可";
  if (marketData.xauPrevClose) {
    prevCloseStr = "$" + marketData.xauPrevClose.toLocaleString();
    if (marketData.xauUsd) {
      const diff = marketData.xauUsd - marketData.xauPrevClose;
      const pct = (diff / marketData.xauPrevClose) * 100;
      changeStr = `${diff >= 0 ? "+" : ""}${diff.toFixed(2)}ドル（${diff >= 0 ? "+" : ""}${pct.toFixed(2)}%）`;
    }
  }

  const marketDataContext = `
【実データ（API取得値・必ずこの数値を基準にすること）】
- XAU/USD 現在値（NYクローズ時点に近い値）: ${marketData.xauUsd ? "$" + marketData.xauUsd.toLocaleString() : "データ取得不可"}
- 前日終値: ${prevCloseStr}
- 前日比: ${changeStr}
- ドル円 (USD/JPY): ${marketData.usdJpy ? marketData.usdJpy + "円" : "データ取得不可"}
`;

  console.log("【2/4】Gemini APIによるゴールド朝報レポート生成中...");

  const todayStr = new Date().toLocaleDateString("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const prompt = `
以下の実データと最新ニュースをもとに、金融メディア「投資の種」に掲載するゴールド（XAU/USD）の日次朝刊レポート「ゴールド朝報」を【日本語】で作成してください。

【読者像】
為替トレーダー（FX・CFDでドル建て金 XAU/USD を取引する層）をメインターゲットとします。現物・純金積立の投資家向けの記述（円/g換算など）は一切不要です。実践的なトレード視点で記述してください。

${marketDataContext}

【入力ニュース情報】
${newsContext}

【厳守する構成ルール】
思考プロセスや前置きは一切含めず、以下のMarkdown構造のみを出力してください（コードブロック \`\`\` は使わない）。
※全体の分量は【本文2,500〜3,000文字程度】（5分で読めるボリューム）に厳密に収めてください。各セクションは簡潔に、冗長な表現は避けてください。
※表形式（Markdownテーブル）は使用禁止です。必ず箇条書き（* ）で記述してください。
※【箇条書きの厳格ルール】
  - 箇条書きは必ず行頭を半角「* 」（アスタリスク＋半角スペース1つ）で開始すること。「- 」「・」は使用禁止。
  - ネスト（インデント付きの入れ子箇条書き）は絶対に使用しないこと。すべての箇条書きは行頭から開始するフラット構造にすること。
  - 1つの箇条書き項目の中で改行しないこと。1項目＝1行で完結させること。
  - 箇条書きの前後には必ず空行を1行入れること。
  - 見出し記号（#）の後は必ず半角スペース1つ（例: ## セクション1：前日のゴールド）。
※価格はドル建て（$/オンス）表記のみ。円建て換算は不要です。
※英語ソースのニュースは日本語に翻訳・要約して記述してください。
※チャート画像はスクリプト側で挿入するため、本文中に画像やプレースホルダーを含めないでください。

【AI自動生成に関するご案内】
※本記事は生成AIを活用して各種市場データ・ニュースを自動収集・要約した速報レポートです。情報の正確性・完全性・即時性を保証するものではありません。投資判断等の最終決定は必ずご自身の責任で行ってください。

---

昨晩のNY金相場の方向感（上昇/下落/もみ合い）と主因を一言でまとめたリード文（2〜3行の段落）。XAU/USDトレーダー視点での地合いを明記。

## セクション1：前日のゴールド

* **XAU/USD 終値:** 実データの終値・前日比（変動額と変動率）を記載。
* **ひとこと総括:** 終値水準が直近レンジのどの位置にあるか（高値圏/安値圏/レンジ中央など）を一言で。
（※この直下にチャート画像が自動挿入されます）

## セクション2：前日の動向

### 米金利・米国債との相関性
前日のXAU/USDの値動きと、米10年債利回り・実質金利・ドル指数（DXY）の動きとの相関性（または逆相関性）を分析してください。「金利低下→金上昇」といった典型的な逆相関がどの程度機能したか、ニュースの内容から判断できる範囲で「相関が強かった/弱かった/無相関だった」の評価とその根拠を記述。数値の創作は禁止。

### 地政学リスク ピックアップ（最大2本）
ニュースから地政学リスク関連の注目材料を最大2本まで選定し、それぞれ箇条書きで「見出し＋金相場への影響の方向性」を記述。該当ニュースがなければ「目立った地政学リスク材料はありませんでした」と記載。

### 米国政府の動き・各国中銀の買い入れ状況
財政政策・関税・制裁など米国政府の動きや、各国中央銀行のゴールド買い入れに関するニュースがあれば共有。なければその旨を記載。

## セクション3：前日の相場盛り上がり度

前日の値幅（前日比の大きさ）と材料の質を踏まえ、市場のボラティリティを5段階（★1=閑散 〜 ★5=激動）で評価し、その根拠を2〜3文で説明。見出しは「## セクション3：前日の相場盛り上がり度 ★★★☆☆」のように星評価を見出し末尾に付けてください。

## セクション4：本日の注目動向

* **経済指標:** 本日（日本時間）発表のゴールド関連経済指標を時系列で箇条書き（形式: * **時刻（日本時間）** 【米】指標名（予想/前回が分かれば記載））。
* **要人発言:** FRB高官・財務長官などの発言予定。予定が不明なら「注目の要人発言予定は確認できていません」と記載。
* **地政学リスク:** 本日注意すべき地政学リスクの継続監視ポイント。

## セクション5：本日の想定高安値

* **本日の想定高値:** セクション3の盛り上がり度（ボラティリティ評価）とセクション4のイベントリスクを根拠に、具体的なドル建て価格で提示。現在値と整合する現実的な数値にすること。
* **本日の想定安値:** 同様に提示。
* **今週の残り市場で意識すべき材料:** 週内に控える重要指標・要人動向・ニュースリスクを箇条書きで共有。

---
※本記事は情報提供を目的としており、投資勧誘を目的としたものではありません。投資判断はご自身の責任で行ってください。
出典・引用：KITCO News / Goldhub (World Gold Council) / GoldSeek.com / Yahoo!ニュース / Reuters / Trading Economics / gold-api.com / frankfurter.app（参照した記事URLを箇条書きで列挙）
`;

  const rawArticleMd = await generateArticleWithGemini(prompt);
  const cleanMd = rawArticleMd
    .replace(/```markdown/gi, "")
    .replace(/```/g, "")
    .trim();

  // タイトル用の方向感を実データから判定
  let trendStr = "もみ合い";
  if (marketData.xauUsd && marketData.xauPrevClose) {
    const diff = marketData.xauUsd - marketData.xauPrevClose;
    const pct = (diff / marketData.xauPrevClose) * 100;
    trendStr = pct > 0.3 ? "上昇" : pct < -0.3 ? "下落" : "小動き";
  }
  const priceStr = marketData.xauUsd ? `$${marketData.xauUsd.toLocaleString()}` : "";
  const postTitle = `【ゴールド朝報】${todayStr} NY金${trendStr}${priceStr ? ` ${priceStr}台` : ""}／本日の注目ポイント`;

  console.log("【3/4】Wix RichContent形式に構造化して送信中...");

  const memberId = await getWixMemberId();
  const richContentNodes = parseMarkdownToWixNodes(cleanMd);

  // セクション1（前日のゴールド）の直後にチャート画像を挿入
  // Wixの画像ノードは外部URL不可のため、Playwrightで実スクリーンショット→Wixメディアにアップロードして挿入
  const chartBuffer = await captureGoldChart();
  let uploadedChart = null;
  if (chartBuffer) {
    try {
      uploadedChart = await uploadImageToWix(chartBuffer, "gold-chart.png");
    } catch (e) {
      console.warn(`チャート画像のWixアップロードに失敗しました: ${e.message}`);
    }
  }

  const section1Index = richContentNodes.findIndex(
    (n) =>
      n.type === "HEADING" &&
      n.nodes?.[0]?.textData?.text?.includes("セクション1")
  );

  if (uploadedChart) {
    const chartNode = createImageNode(
      uploadedChart.mediaId,
      uploadedChart.staticUrl,
      "XAU/USD 日足チャート（TradingView）",
      CHART_WIDTH,
      CHART_HEIGHT
    );
    if (section1Index !== -1) {
      // 見出し直後の空行ノードを挟んで画像を挿入
      richContentNodes.splice(section1Index + 1, 0, chartNode, createEmptyLineNode());
    } else {
      console.warn("セクション1の見出しが見つからないため、チャート画像は記事末尾に追加します。");
      richContentNodes.push(createEmptyLineNode(), chartNode);
    }
    console.log("チャート画像ノードを挿入しました。");
  } else {
    // 画像取得・アップロードに失敗した場合はリンクテキストでフォールバック
    console.warn("チャート画像を挿入できないため、代わりにリンクテキストを挿入します。");
    const fallbackNode = createTextParagraph(
      `※チャート画像の生成に失敗しました。XAU/USDチャートはこちら: ${CHART_WIDGET_URL}`
    );
    if (section1Index !== -1) {
      richContentNodes.splice(section1Index + 1, 0, fallbackNode, createEmptyLineNode());
    } else {
      richContentNodes.push(createEmptyLineNode(), fallbackNode);
    }
  }

  const wixUrl = "https://www.wixapis.com/blog/v3/draft-posts";
  // 共通カテゴリとゴールド専用カテゴリの両方を付与（重複排除）
  const categoryList = [WIX_CATEGORY_ID, WIX_GOLD_CATEGORY_ID]
    .filter((id) => id && id.trim().length > 0)
    .map((id) => id.trim())
    .filter((id, index, arr) => arr.indexOf(id) === index);
  console.log(`付与カテゴリ: ${categoryList.length > 0 ? categoryList.join(", ") : "なし"}`);

  const payload = {
    draftPost: {
      title: postTitle,
      memberId: memberId,
      richContent: {
        nodes: richContentNodes,
      },
      categoryIds: categoryList,
    },
  };

  // 1. まず下書き（Draft）を作成
  const response = await axios.post(wixUrl, payload, {
    headers: {
      Authorization: WIX_API_KEY,
      "wix-site-id": WIX_SITE_ID,
      "Content-Type": "application/json",
    },
    timeout: WIX_API_TIMEOUT,
  });

  const draftId = response.data.draftPost?.id;
  console.log(`下書き作成完了 (Draft ID: ${draftId || "OK"})`);

  // 検証: Wixに保存された画像ノードの状態を確認（画像が空白の場合の切り分け用）
  if (draftId && uploadedChart) {
    try {
      const verifyRes = await axios.get(
        `https://www.wixapis.com/blog/v3/draft-posts/${draftId}?fieldsets=RICH_CONTENT`,
        {
          headers: { Authorization: WIX_API_KEY, "wix-site-id": WIX_SITE_ID },
          timeout: WIX_API_TIMEOUT,
        }
      );
      const savedImageNode = verifyRes.data?.draftPost?.richContent?.nodes?.find(
        (n) => n.type === "IMAGE"
      );
      if (savedImageNode) {
        console.log("保存された画像ノード:", JSON.stringify(savedImageNode.imageData, null, 2));
      } else {
        console.warn("保存されたドラフト内にIMAGEノードが見つかりませんでした。");
      }
    } catch (verifyErr) {
      console.warn(`保存状態の検証に失敗: ${verifyErr.message}`);
    }
  }

  // 2. POST_STATUS が 'publish' の場合は即時公開
  if (POST_STATUS === "publish" && draftId) {
    console.log("【4/4】公開モード（publish）のため、記事を即時公開します...");
    const publishUrl = `https://www.wixapis.com/blog/v3/draft-posts/${draftId}/publish`;
    await axios.post(
      publishUrl,
      {},
      {
        headers: {
          Authorization: WIX_API_KEY,
          "wix-site-id": WIX_SITE_ID,
          "Content-Type": "application/json",
        },
        timeout: WIX_API_TIMEOUT,
      }
    );
    console.log(`🎉 記事を公開（Published）しました！ (Post ID: ${draftId})`);
  } else {
    console.log(`🎉 記事を下書き（Draft）として保存しました！ (Draft ID: ${draftId})`);
  }

  // axiosのkeep-aliveソケット等でプロセスが残留しないよう明示的に終了（GitHub Actionsのジョブハング防止）
  console.log("パイプライン正常終了。");
  process.exit(0);
}

runPipeline().catch((err) => {
  console.error("パイプライン実行エラー:", err.response?.data ? JSON.stringify(err.response.data) : err.message);
  process.exit(1);
});
