import { GoogleGenerativeAI } from "@google/generative-ai";
import Parser from "rss-parser";
import axios from "axios";

// 環境変数の取得
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const WIX_API_KEY = process.env.WIX_API_KEY;
const WIX_SITE_ID = process.env.WIX_SITE_ID;
const WIX_CATEGORY_ID = process.env.WIX_CATEGORY_ID;

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const parser = new Parser();

async function runPipeline() {
  console.log("【1/4】金融ニュースデータの収集開始...");
  
  const query = encodeURIComponent("株式 為替 米国市場");
  const rssUrl = `https://news.google.com/rss/search?q=${query}&hl=ja&gl=JP&ceid=JP:ja`;
  
  const feed = await parser.parseURL(rssUrl);
  
  const topHeadlines = feed.items
    .slice(0, 6)
    .map((item, idx) => `${idx + 1}. ${item.title} (${item.link})`)
    .join("\n");

  console.log("【2/4】Gemini APIによる記事生成中...");
  // 最新のFlashモデルを指定
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

  const todayStr = new Date().toLocaleDateString("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const prompt = `
あなたは金融メディア「投資の種」の専属マーケットアナリストです。
入力された最新ニュース情報をもとに、読者（個人投資家）向けの日次市況サマリー記事（HTML形式）を作成してください。

【入力ニュース】
${topHeadlines}

【構成要件】
- 読者が朝3分でマーケット動向を把握できる構成。
- 以下のHTML構造（Markdownコードブロック \`\`\`html は使わず純粋なHTML文字列のみ出力）：
  1. リード文（<p>タグで相場の要点を2〜3行で）
  2. <h2>本日のマーケット動向・注目材料</h2>
  3. <h3>トピック別の詳細解説（2〜3項目）</h3>
  4. <h2>今後の注目イベント・経済指標</h2>
  5. 免責事項（必須）：
     <hr><p style="font-size:0.85em;color:#666;">※本記事は情報提供を目的としており、投資勧誘を目的としたものではありません。投資判断はご自身の責任で行ってください。<br>出典・引用：Google News配信各社</p>
`;

  const result = await model.generateContent(prompt);
  let articleHtml = result.response.text();
  articleHtml = articleHtml.replace(/```html/g, "").replace(/```/g, "").trim();

  const postTitle = `【朝刊まとめ】${todayStr}の金融市場動向と注目ポイント`;

  console.log("【3/4】Wix Blog API（下書き作成）へ送信中...");

  const wixUrl = "https://www.wixapis.com/blog/v3/draft-posts";

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
      categoryIds: WIX_CATEGORY_ID ? [WIX_CATEGORY_ID] : [],
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
