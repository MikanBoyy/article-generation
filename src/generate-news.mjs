import Parser from "rss-parser";
import axios from "axios";

// 環境変数の取得
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const WIX_API_KEY = process.env.WIX_API_KEY;
const WIX_SITE_ID = process.env.WIX_SITE_ID;
const WIX_CATEGORY_ID = process.env.WIX_CATEGORY_ID;
const WIX_MEMBER_ID = process.env.WIX_MEMBER_ID;
const POST_STATUS = process.env.POST_STATUS || "draft"; // 'publish' または 'draft'

const parser = new Parser({
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Accept: "application/rss+xml, application/xml, text/xml, */*",
  },
  timeout: 10000,
});

// 1. 金融・経済・国際ニュースの多角収集
async function fetchMarketNews() {
  const rssSources = [
    "https://news.yahoo.co.jp/rss/topics/business.xml", // 経済トピックス
    "https://news.yahoo.co.jp/rss/topics/world.xml",    // 国際情勢・地政学
    "https://www3.nhk.or.jp/rss/news/cat6.xml",         // NHK 経済
  ];

  const allHeadlines = [];

  for (const url of rssSources) {
    try {
      console.log(`RSS取得中: ${url}`);
      const feed = await parser.parseURL(url);
      if (feed && feed.items && feed.items.length > 0) {
        const top = feed.items.slice(0, 5).map((item) => {
          return `- 【${item.title}】\n  概要: ${item.contentSnippet || item.content || "速報"}\n  URL: ${item.link}`;
        });
        allHeadlines.push(...top);
      }
    } catch (e) {
      console.warn(`RSS取得スキップ (${url}): ${e.message}`);
    }
  }

  if (allHeadlines.length === 0) {
    throw new Error("すべてのニュースソースからの取得に失敗しました。");
  }

  return allHeadlines.join("\n\n");
}

// 2. Gemini APIによる高品質レポート生成（Flash系モデル自動フォールバック）
async function generateArticleWithGemini(prompt) {
  const priorityOrder = [
    "models/gemini-3.7-flash",
    "models/gemini-3.5-flash",
    "models/gemini-3.6-flash",
    "models/gemini-flash-latest",
    "models/gemini-3.1-flash-lite",
  ];

  const systemInstruction = `あなたは金融情報メディア「投資の種」の専属シニアマーケットアナリストです。
朝の取引開始（寄り付き）前に読まれることを前提とした、論理的かつ実戦的な朝刊市況レポートを【日本語】で作成してください。
思考プロセスや英語の解説、マークダウンのコードブロック（\`\`\`markdown 等）は一切出力せず、指定された構成の【日本語の記事本文のみ】を出力してください。`;

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
              temperature: 0.35,
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

// 3. インライン装飾（太字 **text**）のパース処理
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

// 4. 空白行（空の段落ノード）の生成ヘルパー
function createEmptyLineNode() {
  return {
    type: "PARAGRAPH",
    nodes: [{ type: "TEXT", textData: { text: "", decorations: [] } }],
  };
}

// 5. MarkdownをWix RichContentに変換（セクション・見出し間の余白制御）
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

// 6. Wix APIから有効な memberId を確実に取得
async function getWixMemberId() {
  const headers = {
    Authorization: WIX_API_KEY,
    "wix-site-id": WIX_SITE_ID,
  };

  try {
    const res = await axios.get("https://www.wixapis.com/blog/v3/draft-posts?paging.limit=10", { headers });
    const drafts = res.data.draftPosts || [];
    for (const d of drafts) {
      if (d.memberId) return d.memberId;
    }
  } catch (e) {}

  try {
    const res = await axios.get("https://www.wixapis.com/blog/v3/posts?paging.limit=10", { headers });
    const posts = res.data.posts || [];
    for (const p of posts) {
      if (p.memberId) return p.memberId;
    }
  } catch (e) {}

  try {
    const res = await axios.get("https://www.wixapis.com/members/v1/members?paging.limit=10", { headers });
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
  console.log("【1/4】最新の金融・マクロ・国際ニュース収集開始...");
  const newsContext = await fetchMarketNews();

  console.log("【2/4】Gemini APIによる構造化レポート生成中...");

  const todayStr = new Date().toLocaleDateString("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const prompt = `
以下の最新ニュース情報をもとに、金融メディア「投資の種」に掲載する日次マーケットレポート（朝刊）を【日本語】で作成してください。

【入力ニュース情報】
${newsContext}

【厳守する構成ルール】
思考プロセスや前置きは一切含めず、以下のMarkdown構造のみを出力してください（コードブロック \`\`\` は使わない）：

【AI自動生成に関するご案内】
※本記事は生成AIを活用して各種金融・経済ニュースを自動収集・要約した速報レポートです。情報の正確性・完全性・即時性を保証するものではありません。投資判断等の最終決定は必ずご自身の責任で行ってください。

---

昨晩〜前日までの世界金融市場およびマクロ経済の動向を簡潔に総括したリード文（2〜3行の段落）。全体的な地合いや、本日の日本市場開始に向けた投資家心理のトーンを明記。

## 1. 金融市場を動かす4大観点サマリー

### マクロ経済・金融政策
* **金融政策・金利動向:** 主要中銀（FRB・日銀・ECB等）の動向や金利・インフレに関する材料と分析。
* **経済指標の影響:** 発表された景気データやマクロ動向の要約。

### 地政学リスク・要人発言
* **国際情勢・政策動向:** 国際関係、貿易、安全保障などの地政学的リスク。
* **要人発言の示唆:** 政策担当者や金融首脳の発言が相場に与える影響。

### 企業業績・個別テーマ
* **セクター動向・注目企業:** 決算動向や主力銘柄・AI/半導体等のテーマ株の動き。
* **ビジネス・産業の変化:** 投資家が注目すべき業界トレンド。

### 投資家心理・市場データ
* **リスクセンチメント:** 市場のリスクオン/リスクオフの度合いと資金フロー。
* **為替・コモディティの相関:** ドル円動向や原油・ゴールドなどの材料整理。

## 2. 本日（日本市場開始以降）の世界3大市場・着目ポイント

### 日本市場（前場寄り付き〜大引け）
* **寄り付き・前場の視点:** 昨晩の海外市場の流れを受けた日経平均・TOPIXの寄り付き気配、為替（ドル円）の感応度、主力の半導体・輸出・内需株の物色動向。
* **日中の需給と焦点:** 前場の商い傾向、後場に向けた日銀・機関投資家の動き、大引けに向けた需給要因。

### ロンドン市場（欧州時間）
* **欧州時間の材料:** 夕方以降の欧州主要株価指数（DAX/FTSE等）の方向感、英ポンド・ユーロの動向、欧州時間発表の経済指標や要人発言。

### ニューヨーク市場（米国時間）
* **米国時間の展望:** 今晩の米市場開始前に注目すべき経済指標（インフレ・雇用等）、米長期金利の推移、主要ハイテク・バリュー株の先物動向。

---
※本記事は情報提供を目的としており、投資勧誘を目的としたものではありません。投資判断はご自身の責任で行ってください。
出典・引用：Yahoo!ニュース / 各社報道（参照した記事URLを箇条書きで列挙）
`;

  const rawArticleMd = await generateArticleWithGemini(prompt);
  const cleanMd = rawArticleMd
    .replace(/```markdown/gi, "")
    .replace(/```/g, "")
    .trim();

  const postTitle = `【朝刊まとめ】${todayStr}の金融市場動向と本日の世界3大市場着目点`;

  console.log("【3/4】Wix RichContent形式に構造化して送信中...");

  const memberId = await getWixMemberId();
  const richContentNodes = parseMarkdownToWixNodes(cleanMd);

  const wixUrl = "https://www.wixapis.com/blog/v3/draft-posts";
  const categoryList = WIX_CATEGORY_ID && WIX_CATEGORY_ID.trim().length > 0 ? [WIX_CATEGORY_ID.trim()] : [];

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
  });

  const draftId = response.data.draftPost?.id;
  console.log(`下書き作成完了 (Draft ID: ${draftId || "OK"})`);

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
      }
    );
    console.log(`🎉 記事を公開（Published）しました！ (Post ID: ${draftId})`);
  } else {
    console.log(`🎉 記事を下書き（Draft）として保存しました！ (Draft ID: ${draftId})`);
  }
}

runPipeline().catch((err) => {
  console.error("パイプライン実行エラー:", err.response?.data ? JSON.stringify(err.response.data) : err.message);
  process.exit(1);
});
