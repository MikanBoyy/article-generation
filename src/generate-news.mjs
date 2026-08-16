import Parser from "rss-parser";
import axios from "axios";

// 環境変数の取得
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const WIX_API_KEY = process.env.WIX_API_KEY;
const WIX_SITE_ID = process.env.WIX_SITE_ID;
const WIX_CATEGORY_ID = process.env.WIX_CATEGORY_ID;
const WIX_MEMBER_ID = process.env.WIX_MEMBER_ID;

const parser = new Parser({
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Accept: "application/rss+xml, application/xml, text/xml, */*",
  },
  timeout: 10000,
});

// 1. 金融・経済ニュースの収集
async function fetchMarketNews() {
  const rssSources = [
    "https://news.yahoo.co.jp/rss/topics/business.xml",
    "https://www3.nhk.or.jp/rss/news/cat6.xml",
  ];

  for (const url of rssSources) {
    try {
      console.log(`RSS取得試行中: ${url}`);
      const feed = await parser.parseURL(url);
      if (feed && feed.items && feed.items.length > 0) {
        return feed.items
          .slice(0, 8)
          .map((item, idx) => {
            return `${idx + 1}. 【タイトル】${item.title}\n   【リンク】${item.link}\n   【概要】${item.contentSnippet || item.content || "速報ニュース"}`;
          })
          .join("\n\n");
      }
    } catch (e) {
      console.warn(`RSS取得スキップ (${url}): ${e.message}`);
    }
  }

  throw new Error("すべてのニュースソースからの取得に失敗しました。");
}

// 2. 無料枠で確実に動作する Flash 系モデル群による記事生成
async function generateArticleWithGemini(prompt) {
  const priorityOrder = [
    "models/gemini-3.7-flash",
    "models/gemini-3.5-flash",
    "models/gemini-3.6-flash",
    "models/gemini-flash-latest",
    "models/gemini-3.1-flash-lite",
  ];

  const systemInstruction = `あなたは金融情報メディア「投資の種」の専属マーケットアナリストです。
必ず【日本語】で記事を執筆してください。
思考プロセス、考察メモ、英語の解説、マークダウンのコードブロック（\`\`\`markdown 等）は一切出力せず、指定された構成の【日本語の記事本文のみ】を出力してください。`;

  for (const modelName of priorityOrder) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        console.log(`記事生成を試行中: ${modelName} (試行回数: ${attempt}/2)`);
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
          console.log(`モデル [${modelName}] で記事生成に成功しました！`);
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

  throw new Error("利用可能なすべてのGeminiモデルでの記事生成に失敗しました。");
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

// 4. MarkdownをWix RichContent（見出し・箇条書き・段落・区切り線）に変換
function parseMarkdownToWixNodes(mdText) {
  const lines = mdText.split("\n");
  const nodes = [];
  let currentBulletList = [];

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
      nodes.push({
        type: "HEADING",
        headingData: { level: 2 },
        nodes: parseInlines(trimmed.slice(3).trim()),
      });
    } else if (trimmed.startsWith("### ")) {
      flushBulletList();
      nodes.push({
        type: "HEADING",
        headingData: { level: 3 },
        nodes: parseInlines(trimmed.slice(4).trim()),
      });
    } else if (trimmed === "---" || trimmed === "***" || trimmed === "___") {
      flushBulletList();
      nodes.push({
        type: "DIVIDER",
        dividerData: { lineStyle: "SINGLE", width: "LARGE", alignment: "CENTER" },
      });
    } else if (trimmed.startsWith("* ") || trimmed.startsWith("- ")) {
      currentBulletList.push(trimmed.slice(2).trim());
    } else {
      flushBulletList();
      nodes.push({
        type: "PARAGRAPH",
        nodes: parseInlines(trimmed),
      });
    }
  }

  flushBulletList();
  return nodes;
}

// 5. Wix APIから有効な memberId を確実に自動検出
async function getWixMemberId() {
  const headers = {
    Authorization: WIX_API_KEY,
    "wix-site-id": WIX_SITE_ID,
  };

  // ① 既存の下書き記事から自動取得
  try {
    const res = await axios.get("https://www.wixapis.com/blog/v3/draft-posts?paging.limit=10", { headers });
    const drafts = res.data.draftPosts || [];
    for (const d of drafts) {
      if (d.memberId) {
        console.log(`下書き記事から有効な memberId を自動検出: ${d.memberId}`);
        return d.memberId;
      }
    }
  } catch (e) {}

  // ② 既存の公開記事から自動取得
  try {
    const res = await axios.get("https://www.wixapis.com/blog/v3/posts?paging.limit=10", { headers });
    const posts = res.data.posts || [];
    for (const p of posts) {
      if (p.memberId) {
        console.log(`公開記事から有効な memberId を自動検出: ${p.memberId}`);
        return p.memberId;
      }
    }
  } catch (e) {}

  // ③ サイトメンバー一覧 API から自動取得
  try {
    const res = await axios.get("https://www.wixapis.com/members/v1/members?paging.limit=10", { headers });
    const members = res.data.members || [];
    if (members.length > 0 && members[0].id) {
      console.log(`サイトメンバーAPIから有効な memberId を自動検出: ${members[0].id}`);
      return members[0].id;
    }
  } catch (e) {}

  // ④ フォールバックとして環境変数を使用
  if (WIX_MEMBER_ID && WIX_MEMBER_ID.trim().length > 0) {
    console.log(`環境変数 WIX_MEMBER_ID を使用: ${WIX_MEMBER_ID.trim()}`);
    return WIX_MEMBER_ID.trim();
  }

  throw new Error(
    "Wixの有効なmemberIdが見つかりませんでした。Wixダッシュボードのブログ管理画面でタイトルだけの「テスト下書き」を1件保存してから再実行してください。"
  );
}

async function runPipeline() {
  console.log("【1/4】金融ニュースデータの収集開始...");
  const topHeadlines = await fetchMarketNews();

  console.log("【2/4】Gemini APIによる記事生成中...");

  const todayStr = new Date().toLocaleDateString("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const prompt = `
以下の最新ニュース情報をもとに、個人投資家・資産形成層に向けた日次市況サマリー記事を【日本語】で作成してください。

【入力ニュース情報】
${topHeadlines}

【厳守する出力ルール】
- 思考プロセスや前置き、解説などは一切含めず、記事本文のみを出力してください。
- 出力は必ず以下の見出し・Markdown構造にしてください（コードブロック \`\`\` は使わない）：

本日の経済・マーケット全体の動きを簡潔に2〜3行で要約したリード文。

## 本日のマーケット動向・注目材料

### 1. 主要トピック名
* **ポイント見出し:** 投資家視点での解説内容。
* **関連動向:** 市場や企業業績への影響。

### 2. 主要トピック名
* **ポイント見出し:** 投資家視点での解説内容。

## 今後の注目イベント・経済指標
* **注目ポイント:** 今後発表される主要指標や相場への影響。

---
※本記事は情報提供を目的としており、投資勧誘を目的としたものではありません。投資判断はご自身の責任で行ってください。
出典・引用：Yahoo!ニュース / 各社報道
`;

  const rawArticleMd = await generateArticleWithGemini(prompt);
  const cleanMd = rawArticleMd
    .replace(/```markdown/gi, "")
    .replace(/```/g, "")
    .trim();

  const postTitle = `【朝刊まとめ】${todayStr}の金融市場動向と注目ポイント`;

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

  const response = await axios.post(wixUrl, payload, {
    headers: {
      Authorization: WIX_API_KEY,
      "wix-site-id": WIX_SITE_ID,
      "Content-Type": "application/json",
    },
  });

  console.log(`【4/4】🎉 Wixへのリッチテキスト下書き投稿が完了しました！ (Post ID: ${response.data.draftPost?.id || "OK"})`);
}

runPipeline().catch((err) => {
  console.error("パイプライン実行エラー:", err.response?.data ? JSON.stringify(err.response.data) : err.message);
  process.exit(1);
});
