import { GoogleGenerativeAI } from "@google/generative-ai";
import Parser from "rss-parser";
import axios from "axios";

// 環境変数の取得
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const WIX_API_KEY = process.env.WIX_API_KEY;
const WIX_SITE_ID = process.env.WIX_SITE_ID;
const WIX_CATEGORY_ID = process.env.WIX_CATEGORY_ID;

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

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
        return feed.items.slice(0, 8).map((item, idx) => {
          return `${idx + 1}. 【タイトル】${item.title}\n   【リンク】${item.link}\n   【概要】${item.contentSnippet || item.content || "速報ニュース"}`;
        }).join("\n\n");
      }
    } catch (e) {
      console.warn(`RSS取得スキップ (${url}): ${e.message}`);
    }
  }

  throw new Error("すべてのニュースソースからの取得に失敗しました。");
}

// 2. Gemini APIによる記事生成（フォールバック対応）
async function generateArticleWithGemini(prompt) {
  const candidateModels = [
    "gemini-2.0-flash",
    "gemini-1.5-pro",
    "gemini-1.5-flash-002",
    "gemini-pro"
  ];

  for (const modelName of candidateModels) {
    try {
      console.log(`Gemini モデル試行中: ${modelName}`);
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent(prompt);
      const text = result.response.text();
      if (text && text.trim().length > 0) {
        console.log(`モデル [${modelName}] で記事生成に成功しました。`);
        return text;
      }
    } catch (err) {
      console.warn(`モデル [${modelName}] 失敗: ${err.message}。次のモデルを試します。`);
    }
  }

  throw new Error("利用可能なすべてのGeminiモデルでの記事生成に失敗しました。");
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
あなたは金融メディア「投資の種」の専属マーケットアナリストです。
入力された最新の金融・経済ニュース情報をもとに、読者（個人投資家・資産形成層）向けの日次市況サマリー記事（HTML形式）を作成してください。

【入力ニュース情報】
${topHeadlines}

【構成要件】
- 読者が通勤時間等に3分で把握できる論理的かつ分かりやすい構成。
- 出力は純粋なHTMLタグ文字列のみとし、Markdownのコードブロック（\`\`\`html など）は含めないでください。
- 以下の構成で作成してください：
  1. リード文（<p>タグで相場のポイントを簡潔に2〜3行で）
  2. <h2>本日のマーケット動向・注目材料</h2>
  3. <h3>主要トピックの解説（2〜3項目）</h3>
  4. <h2>今後の注目イベント・経済指標</h2>
  5. 免責事項（必須）：
     <hr><p style="font-size:0.85em;color:#666;">※本記事は情報提供を目的としており、投資勧誘を目的としたものではありません。投資判断はご自身の責任で行ってください。<br>出典・引用：Yahoo!ニュース / 各社報道</p>
`;

  const rawArticleHtml = await generateArticleWithGemini(prompt);
  let articleHtml = rawArticleHtml.replace(/```html/g, "").replace(/```/g, "").trim();

  const postTitle = `【朝刊まとめ】${todayStr}の金融市場動向と注目ポイント`;

  console.log("【3/4】Wix Blog API（下書き作成）へ送信中...");

  const wixUrl = "https://www.wixapis.com/blog/v3/draft-posts";
  const categoryList = WIX_CATEGORY_ID && WIX_CATEGORY_ID.trim().length > 0 ? [WIX_CATEGORY_ID.trim()] : [];

  const payload = {
    draftPost: {
      title: postTitle,
      richContent: {
        nodes: [
          {
            type: "PARAGRAPH",
            nodes: [
              {
                type: "TEXT",
                textData: {
                  text: articleHtml
                    .replace(/<[^>]*>?/gm, "\n")
                    .replace(/\n\s*\n/g, "\n\n")
                    .trim(),
                },
              },
            ],
          },
        ],
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

  console.log(`【4/4】Wixへの下書き投稿が完了しました！ (Post ID: ${response.data.draftPost?.id || "OK"})`);
}

runPipeline().catch((err) => {
  console.error("パイプライン実行エラー:", err.response?.data ? JSON.stringify(err.response.data) : err.message);
  process.exit(1);
});