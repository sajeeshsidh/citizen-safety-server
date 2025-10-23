const express = require('express');
const cors = require('cors');
const { GoogleGenAI, Type } = require('@google/genai');

const PORT = process.env.PORT || 3007;
const API_KEY = process.env.API_KEY;

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' })); // Increased limit for audio data

let ai;
if (API_KEY) {
    ai = new GoogleGenAI({ apiKey: API_KEY });
} else {
    console.warn("WARNING: API_KEY environment variable is not set. The AI Analysis Service will not work.");
}

const emergencyClassificationSchema = {
    type: Type.OBJECT,
    properties: {
        category: {
            type: Type.STRING,
            enum: ['Law & Order', 'Fire & Rescue', 'Medical Emergency', 'Traffic Incident'],
            description: 'The classified category of the emergency.',
        },
        reason: {
            type: Type.STRING,
            description: 'A brief explanation for the classification choice.'
        }
    },
    required: ['category', 'reason']
};

app.post('/api/internal/analyze', async (req, res) => {
    if (!ai) {
        return res.status(500).json({ message: 'AI service is not configured.' });
    }

    const { message, audioBase64 } = req.body;
    let analysisText = message;

    // If there's no text message but there is audio, transcribe the audio first.
    if (!analysisText && audioBase64) {
        console.log('[AI Analysis] Received audio-only alert. Attempting transcription...');
        try {
            const audioPart = {
                inlineData: {
                    // The client recorder (expo-audio) typically creates m4a files, which use the mp4 container.
                    mimeType: 'audio/mp4',
                    data: audioBase64,
                },
            };
            const textPart = {
                text: 'Transcribe this audio recording of a person reporting an emergency. Provide only the transcribed text.',
            };

            const transcriptionResponse = await ai.models.generateContent({
                model: 'gemini-2.5-flash', // A multi-modal model that can handle audio
                contents: { parts: [audioPart, textPart] },
            });

            analysisText = transcriptionResponse.text;
            console.log(`[AI Analysis] Transcription successful: "${analysisText}"`);

        } catch (transcriptionError) {
            console.error('[AI Analysis] Audio transcription failed:', transcriptionError);
            // Fallback to placeholder text if transcription fails
            analysisText = "An emergency has been reported via a voice message that could not be transcribed.";
        }
    }

    if (!analysisText) {
        // Default to 'Law & Order' if there's no content to analyze
        return res.json({ category: 'Law & Order', reason: 'No text or audio content provided.' });
    }

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: `Analyze the following emergency report and classify it. Report: "${analysisText}"`,
            config: {
                responseMimeType: "application/json",
                responseSchema: emergencyClassificationSchema,
                systemInstruction: "You are an advanced emergency dispatch system. Your task is to analyze an emergency report and classify it into one of the specified categories. Respond only with the JSON object conforming to the schema."
            }
        });

        const jsonText = response.text.trim();
        const result = JSON.parse(jsonText);

        console.log(`[AI Analysis] Classified "${analysisText.substring(0, 30)}..." as ${result.category}`);
        res.json(result);
    } catch (error) {
        console.error('Error analyzing alert with AI:', error);
        // Fallback to a default category in case of AI error
        res.status(500).json({ category: 'Law & Order', reason: 'AI analysis failed.' });
    }
});

app.listen(PORT, () => console.log(`AI Analysis Service listening on port ${PORT}`));