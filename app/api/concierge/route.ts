import { type NextRequest, NextResponse } from "next/server"

// ★ CSV読み取り（最小動作用：外部CSVでもpublic配下でもOK）
async function fetchCSV(url: string) {
  const res = await fetch(url, { cache: "no-store" })
  if (!res.ok) throw new Error(`CSV fetch failed: ${url} ${res.status}`)
  const text = await res.text()
  const [header, ...rows] = text.trim().split("\n")
  const keys = header.split(",").map((h) => h.trim().replace(/(^"|"$)/g, ""))
  return rows.map((r) => {
    const vals = r.split(",").map((v) => v.trim().replace(/(^"|"$)/g, ""))
    const obj: Record<string, string> = {}
    keys.forEach((k, i) => (obj[k] = vals[i] ?? ""))
    return obj
  })
}

type Spot = {
  spotid?: string
  spotID?: string
  shrine_name?: string
  address?: string
  latitude?: string
  longitude?: string
  category?: string
  benefit_tag_1?: string
  benefit_tag_2?: string
  tag_attribute?: string
  other_benefits?: string
}
type Course = { course_id?: string; courseId?: string; name?: string; description?: string; theme?: string }
type CourseSpot = { course_id?: string; courseId?: string; spot_id?: string; spotid?: string; order?: string }

async function refineWithGemini(apiKey: string, message: string, userQuery: string): Promise<string> {
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: `あなたは福岡市の神社めぐりと観光案内の専門コンシェルジュです。以下の基本情報を、より親しみやすく魅力的な表現に整えてください。

ユーザーの質問: "${userQuery}"
基本応答: "${message}"

【指針】
- 福岡の歴史や文化的背景を織り交ぜる
- 親しみやすく丁寧な敬語を使用
- 神社の魅力や観光の楽しさを伝える
- 実用的な情報（移動手段、所要時間など）も含める
- 温かみのあるコンシェルジュらしい表現にする

整えた応答:`,
                },
              ],
            },
          ],
          generationConfig: {
            temperature: 0.7,
            topK: 40,
            topP: 0.9,
            maxOutputTokens: 512,
          },
        }),
      },
    )

    if (response.ok) {
      const data = await response.json()
      return data.candidates[0].content.parts[0].text
    }
  } catch (error) {
    console.error("Gemini refinement error:", error)
  }
  return message // フォールバック
}

export async function POST(req: NextRequest) {
  // 1) 入力取得
  let body: any = {}
  try {
    body = await req.json()
  } catch {}
  const userQuery: string = body?.query ?? body?.messages?.[body.messages.length - 1]?.content ?? ""
  const preferShrine: string = body?.shrine_name ?? "" // ★必ずshrine_nameフィールドを優先

  // 2) データ読込（実際のCSV URLを使用）
  try {
    const [spots, courses, courseSpots] = await Promise.all([
      fetchCSV(
        "https://hebbkx1anhila5yf.public.blob.vercel-storage.com/shrines%20-%20spot-f1YwPxEbFHsLAyI3T1rupbNUM6pr3I.csv",
      ) as Promise<Spot[]>,
      fetchCSV(
        "https://hebbkx1anhila5yf.public.blob.vercel-storage.com/shrines%20-%20courses-h2iZmLoTHDWZ8VBu3O7IxHKhboDin6.csv",
      ) as Promise<Course[]>,
      fetchCSV(
        "https://hebbkx1anhila5yf.public.blob.vercel-storage.com/shrines%20-%20course_spots-8opDgc9DP48nrsaWyGukc7HGQmNPL8.csv",
      ) as Promise<CourseSpot[]>,
    ])

    // 3) 多段検索
    const norm = (s: string) => (s || "").toLowerCase().trim()
    const stripNoise = (s: string) =>
      (s || "")
        .replace(/[\s\t\r\n]/g, "")
        .replace(/(周辺|近く|付近|周り|ゆかり|について|に関する|周辺の神社|神社|寺)/g, "")
        .trim()

    const rawQuery = (preferShrine || userQuery || "").trim()
    const keyword = stripNoise(rawQuery)
    const q = norm(keyword || rawQuery)

    const allSpots = spots as Spot[]

    // 優先順位: 1) 完全一致 2) 部分一致（名前）3) 部分一致（住所）4) 部分一致（由緒/特徴）
    const byExactName = allSpots.filter((s) => norm(s.shrine_name || "") === q)
    const byPartialName = allSpots.filter((s) => q && norm(s.shrine_name || "").includes(q))
    const byAddress = allSpots.filter((s) => q && norm(s.address || "").includes(q))
    const byBenefits = allSpots.filter((s) => q && norm(s.other_benefits || "").includes(q))

    const seen = new Set<string>()
    const pushUnique = (arr: Spot[], spot: Spot) => {
      const key = (spot.spotid || spot.spotID || spot.shrine_name || "").toString()
      if (!seen.has(key)) {
        seen.add(key)
        arr.push(spot)
      }
      return arr
    }

    const candidates: Spot[] = []
    byExactName.forEach((s) => pushUnique(candidates, s))
    byPartialName.forEach((s) => pushUnique(candidates, s))
    byAddress.forEach((s) => pushUnique(candidates, s))
    byBenefits.forEach((s) => pushUnique(candidates, s))

    if (candidates.length === 0) {
      const message = "該当する神社は見つかりませんでした。キーワードを変えてお試しください。"

      let finalMessage = message
      try {
        const apiKey = process.env.GEMINI_API_KEY
        if (apiKey) {
          finalMessage = await refineWithGemini(apiKey, message, userQuery)
        }
      } catch {}

      return NextResponse.json({ ok: true, message: finalMessage, shrine_name: null, plans: [] })
    }

    // 4) コース候補の抽出（複数神社に対応）
    const plans = candidates.flatMap((spot) => {
      const shrineName = spot.shrine_name || ""
      const spotKey = (spot.spotid || spot.spotID || "").toString()
      const relCourseIds = courseSpots
        .filter((cs) => (cs.spot_id || cs.spotid || "") === spotKey)
        .map((cs) => (cs.course_id || cs.courseId || "").toString())
      return courses
        .filter((c) => relCourseIds.includes((c.course_id || c.courseId || "").toString()))
        .map((c) => ({
          course_id: c.course_id || c.courseId || "",
          name: c.name || "",
          description: c.description || "",
          theme: c.theme || "",
          shrine_name: shrineName,
        }))
    })

    // 5) 応答メッセージ生成
    const topShrineName = candidates[0]?.shrine_name || ""
    let message: string

    if (candidates.length > 1) {
      const list = candidates
        .slice(0, 10)
        .map((c) => `・${c.shrine_name || "名称不明"}${c.address ? `（${c.address}）` : ""}`)
        .join("\n")
      message = `いくつか候補がございます。\n${list}`
    } else {
      const related = plans.filter((p) => p.shrine_name === topShrineName)
      if (related.length === 0) {
        message = `「${topShrineName}」に対応するコースは未登録です。近隣スポット名で再検索してみてください。`
      } else if (related.length === 1) {
        const p = related[0]
        message = `「${topShrineName}」に近いおすすめコースは『${p.name}』です。${p.description || ""}`
      } else {
        message = `「${topShrineName}」の近くには、いくつかプランがございます。\n` +
          related.map((p) => `・『${p.name}』— ${p.description || "説明準備中"}`).join("\n")
      }
    }

    // 6) 可能ならLLMで言い回しを整える（失敗しても握りつぶす）
    let finalMessage = message
    try {
      const apiKey = process.env.GEMINI_API_KEY
      if (apiKey) {
        finalMessage = await refineWithGemini(apiKey, message, userQuery)
      }
    } catch {}

    return NextResponse.json({
      ok: true,
      message: finalMessage,
      shrine_name: topShrineName || null,
      plans,
    })
  } catch (err: any) {
    // 7) どんな例外でも"沈黙させない"
    console.error("[concierge] fatal:", err?.message || err)
    return NextResponse.json({
      ok: false,
      message: "AIコンシェルジュが応答していません。しばらくしてからもう一度お試しください。",
      shrine_name: null,
      plans: [],
      error: "server-failed",
    })
  }
}
