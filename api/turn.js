// api/turn.js
// Vercel serverless function — evaluates the student's latest answer and
// generates the next adaptive question. Called once per conversation turn.
// Requires GEMINI_API_KEY env var (Google AI Studio, free tier).

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({
      error: 'GEMINI_API_KEY is not set on the server. Add it in Vercel > Project Settings > Environment Variables, then redeploy.'
    });
    return;
  }

  const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash';

  try {
    const { history, currentLevelIndex, turnNumber, maxTurns, isCalibration, avoidTopics } = req.body || {};
    if (!Array.isArray(history) || history.length === 0) {
      res.status(400).json({ error: 'Missing "history" array in request body.' });
      return;
    }

    const LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
    const approxLevel = LEVELS[Math.max(0, Math.min(5, currentLevelIndex ?? 2))];
    const isLastTurn = (turnNumber >= (maxTurns || 9));

    const transcript = history.map((h, i) =>
      `Turn ${i + 1} [${h.type}${h.topicCategory ? '/' + h.topicCategory : ''}]: ${h.question}\nStudent: ${h.answer}`
    ).join('\n\n');

    // Phase 2 UX decision: "محادثة تحديد المستوى بأول 1-2 سؤال" — the first
    // couple of turns exist purely to establish a ballpark starting level,
    // before the normal turn-by-turn adaptive escalation takes over. This
    // avoids intimidating a true beginner or boring an advanced speaker
    // while the slower two-in-a-row adaptation rule is still "warming up".
    const calibrationInstructions = isCalibration ? `
- IMPORTANT: this is a CALIBRATION turn (one of the first 1-2 assessed turns). Your job right now is to help place the student's ballpark CEFR level as accurately as possible from this single answer — NOT to escalate or de-escalate difficulty yet.
- Ask the next question at a moderate, universally-approachable difficulty (a concrete, everyday question any level can attempt), regardless of the student's assumed level — do not tailor difficulty to approxLevel during calibration.
- Still classify "turnCefrEstimate" as accurately as possible — this estimate is what determines the student's real starting level, so judge it carefully and don't default to the middle out of caution.
- The "direction" field will be ignored by the caller during calibration — you may still fill it in, but it has no effect this turn.` : `
- This is a normal adaptive turn (calibration is complete). Adapt difficulty using the rules below as usual.`;

    // Phase 6: returning users shouldn't get the same opening topic category
    // as their last session (per the ProgressSnapshot/reports history). This
    // is a soft steer, not a hard ban — never force an awkward question.
    const avoidTopicsList = Array.isArray(avoidTopics) ? avoidTopics.filter(Boolean) : [];
    const avoidTopicsInstructions = avoidTopicsList.length ? `
- This student has a previous session on record. Their last session opened with these topic categories: ${avoidTopicsList.join(', ')}. Prefer a DIFFERENT topic category for this question if one fits just as naturally — avoid repeating the same opening topic across sessions. This is a soft preference: never force an awkward or unnatural question just to dodge a topic.` : '';

    const systemPrompt = `You are an expert English speaking examiner running a live adaptive spoken interview, calibrating difficulty to the CEFR scale (A1-C2) turn by turn.

Rules for adapting difficulty:
- The student's current estimated level is ${approxLevel}. Judge ONLY the most recent answer (the last turn in the transcript).
- Classify the most recent answer's own CEFR level (turnCefrEstimate) based on grammar accuracy, vocabulary range, coherence, and how well it actually answers what was asked. Do NOT judge pronunciation or accent — you only see a text transcript.
- Also output "direction": whether the LAST ANSWER was "harder" (student handled the current question easily, ready for tougher), "same" (matched expectation), or "easier" (student struggled, needs a step down) relative to the question's difficulty. Do not overreact to a single answer — this signal will only be acted on by the caller after two consecutive matching signals.
- If approxLevel is A1/A2: keep the next question short and concrete, never abstract/hypothetical, add a bit of gentle encouragement in quickReply, and never escalate right after a single weak answer.
- If approxLevel is C1/C2: escalate faster, ask a genuine follow-up rooted in specific details from the student's actual last answer (not a generic bank question), and topics can include argumentative/debate prompts.
- Only ask a deeper follow-up ON THE SAME TOPIC as the last question if the last answer left room to go deeper AND approxLevel is B1 or higher. Otherwise move to a fresh topic category.
- Vary topic categories across the session. Categories: intro_daily_life, opinion_reasoning, narrative_experience, hypothetical_planning, argumentative_debate (C1+ only).
- Write natural, everyday spoken English for questions — not textbook-formal English.
${calibrationInstructions}
${avoidTopicsInstructions}
${isLastTurn ? '- This is the FINAL turn of the session. Set "isFinal": true and "nextQuestion": null.' : '- Set "isFinal": false and provide "nextQuestion".'}

Respond with ONLY valid JSON (no markdown fences, no preamble, no explanation outside the JSON). Exact schema:
{
  "turnCefrEstimate": "one of A1|A2|B1|B2|C1|C2",
  "direction": "harder|same|easier",
  "quickReplyEn": "a short (max 12 words) natural conversational reaction to the student's last answer, in English",
  "quickReplyAr": "Gulf Arabic translation/equivalent of quickReplyEn, short",
  "isFinal": ${isLastTurn},
  "nextQuestion": ${isLastTurn ? 'null' : '{"en": "the next question in English", "ar": "Gulf Arabic translation of the question", "type": "talk", "topicCategory": "one of the categories above"}'}
}`;

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [
            { role: 'user', parts: [{ text: 'Interview transcript so far:\n\n' + transcript }] }
          ],
          generationConfig: {
            maxOutputTokens: 500,
            responseMimeType: 'application/json',
            thinkingConfig: { thinkingLevel: 'low' }
          }
        })
      }
    );

    const data = await geminiRes.json();

    if (!geminiRes.ok) {
      res.status(geminiRes.status).json({ error: (data && data.error && data.error.message) || 'Gemini API error' });
      return;
    }

    const textOut = (data.candidates && data.candidates[0] && data.candidates[0].content &&
      data.candidates[0].content.parts && data.candidates[0].content.parts[0] &&
      data.candidates[0].content.parts[0].text) || '';
    const clean = textOut.replace(/```json/g, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(clean);
    res.status(200).json(parsed);
  } catch (err) {
    res.status(500).json({ error: (err && err.message) || 'Unknown server error' });
  }
};
