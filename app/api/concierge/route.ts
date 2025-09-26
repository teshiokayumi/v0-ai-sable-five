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
        "https://docs.google.com/spreadsheets/d/1MQzEv6M9_sxCZ3giqSPYCCTQH_IKx27-LOOeiapUQ3E/gviz/tq?tqx=out:csv&sheet=spot"
      ) as Promise<Spot[]>,
      fetchCSV(
        "https://docs.google.com/spreadsheets/d/1MQzEv6M9_sxCZ3giqSPYCCTQH_IKx27-LOOeiapUQ3E/gviz/tq?tqx=out:csv&sheet=courses"
      ) as Promise<Course[]>,
      fetchCSV(
        "https://docs.google.com/spreadsheets/d/1MQzEv6M9_sxCZ3giqSPYCCTQH_IKx27-LOOeiapUQ3E/gviz/tq?tqx=out:csv&sheet=course_spots"
      ) as Promise<CourseSpot[]>,
    ])
    

    // 3) 多段検索（優先順位に courses 検索を組み込む）
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

    // 優先順位: 1) shrine_name 完全一致 2) shrine_name 部分一致 3) courses 部分一致 4) address 部分一致 5) other_benefits 部分一致
    const byExactName = allSpots.filter((s) => norm(s.shrine_name || "") === q)
    const byPartialName = allSpots.filter((s) => q && norm(s.shrine_name || "").includes(q))
    const byAddress = allSpots.filter((s) => q && norm(s.address || "").includes(q))
    const byBenefits = allSpots.filter((s) => q && norm(s.other_benefits || "").includes(q))

    // courses の部分一致（ランドマーク系を優先）
    const courseHits = (courses as Course[]).filter(
      (c) =>
        q &&
        [c.name || "", c.description || "", c.theme || ""].some((v) => norm(v).includes(q)),
    )

    const seen = new Set<string>()
    const pushUnique = (arr: Spot[], spot: Spot) => {
      const key = (spot.spotid || spot.spotID || spot.shrine_name || "").toString()
      if (!seen.has(key)) {
        seen.add(key)
        arr.push(spot)
      }
      return arr
    }

    // 優先順位に応じた分岐
    // 3-1) shrine_name（完全一致・部分一致）
    const nameCandidates: Spot[] = []
    byExactName.forEach((s) => pushUnique(nameCandidates, s))
    byPartialName.forEach((s) => pushUnique(nameCandidates, s))

    if (nameCandidates.length > 0) {
      // 神社候補に対するコース抽出
      const plans = nameCandidates.flatMap((spot) => {
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

      const topShrineName = nameCandidates[0]?.shrine_name || ""
      let message: string
      if (nameCandidates.length > 1) {
        const list = nameCandidates
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

      let finalMessage = message
      try {
        const apiKey = process.env.GEMINI_API_KEY
        if (apiKey) finalMessage = await refineWithGemini(apiKey, message, userQuery)
      } catch {}

      return NextResponse.json({ ok: true, message: finalMessage, shrine_name: topShrineName || null, plans })
    }

    // 3-2) courses（ランドマーク系）
    if (courseHits.length > 0) {
      const plans = courseHits.map((c) => ({ name: c.name || "", description: c.description || "", theme: c.theme || "" }))

      // コースに含まれる神社名の列挙
      const courseIdSet = new Set(
        courseHits.map((c) => (c.course_id || c.courseId || "").toString())
      )
      const spotIdSet = new Set(
        (courseSpots as CourseSpot[])
          .filter((cs) => courseIdSet.has((cs.course_id || cs.courseId || "").toString()))
          .map((cs) => (cs.spot_id || cs.spotid || "").toString())
      )
      const relatedShrines = (allSpots as Spot[])
        .filter((s) => spotIdSet.has((s.spotid || s.spotID || "").toString()))
        .map((s) => s.shrine_name || "")
        .filter(Boolean)

      const uniqueShrines: string[] = Array.from(new Set(relatedShrines))
      const topShrineName = uniqueShrines[0] || null

      let message: string
      if (courseHits.length === 1) {
        const c = courseHits[0]
        message = `該当するコースは『${c.name || "名称未設定"}』です。${c.description || ""}`
      } else {
        const list = courseHits
          .slice(0, 10)
          .map((c) => `・『${c.name || "名称未設定"}』— ${c.description || "説明準備中"}`)
          .join("\n")
        message = `いくつか候補のコースがございます。\n${list}`
      }

      if (uniqueShrines.length > 0) {
        message += `\n含まれる神社：${uniqueShrines.join("、")}`
      }

      let finalMessage = message
      try {
        const apiKey = process.env.GEMINI_API_KEY
        if (apiKey) finalMessage = await refineWithGemini(apiKey, message, userQuery)
      } catch {}

      return NextResponse.json({ ok: true, message: finalMessage, shrine_name: topShrineName, plans })
    }

    // 3-3) address / other_benefits
    const tailCandidates: Spot[] = []
    byAddress.forEach((s) => pushUnique(tailCandidates, s))
    byBenefits.forEach((s) => pushUnique(tailCandidates, s))

    if (tailCandidates.length === 0) {
      const message = "該当する神社やコースは見つかりませんでした。"
      return NextResponse.json({ ok: true, message, shrine_name: null, plans: [] })
    }

    const tailPlans = tailCandidates.flatMap((spot) => {
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

    const topTailShrine = tailCandidates[0]?.shrine_name || ""
    let tailMessage: string
    if (tailCandidates.length > 1) {
      const list = tailCandidates
        .slice(0, 10)
        .map((c) => `・${c.shrine_name || "名称不明"}${c.address ? `（${c.address}）` : ""}`)
        .join("\n")
      tailMessage = `いくつか候補がございます。\n${list}`
    } else {
      const related = tailPlans.filter((p) => p.shrine_name === topTailShrine)
      if (related.length === 0) {
        tailMessage = `「${topTailShrine}」に対応するコースは未登録です。近隣スポット名で再検索してみてください。`
      } else if (related.length === 1) {
        const p = related[0]
        tailMessage = `「${topTailShrine}」に近いおすすめコースは『${p.name}』です。${p.description || ""}`
      } else {
        tailMessage = `「${topTailShrine}」の近くには、いくつかプランがございます。\n` +
          related.map((p) => `・『${p.name}』— ${p.description || "説明準備中"}`).join("\n")
      }
    }

    let finalTailMessage = tailMessage
    try {
      const apiKey = process.env.GEMINI_API_KEY
      if (apiKey) finalTailMessage = await refineWithGemini(apiKey, tailMessage, userQuery)
    } catch {}

    return NextResponse.json({ ok: true, message: finalTailMessage, shrine_name: topTailShrine || null, plans: tailPlans })
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
