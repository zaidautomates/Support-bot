// Node/Express Server - NeuralChat Secure Backend
// Manages static serving, clean routes, config exposing, and secure Groq completions

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const Groq = require('groq-sdk');

const app = express();
const PORT = process.env.PORT || 3050;

app.use(cors());
app.use(express.json());

// Serve static assets from public
app.use(express.static(path.join(__dirname, 'public')));

// Initialize Supabase Client with service role key for secure backend database management
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
let supabase = null;

if (supabaseUrl && supabaseServiceKey) {
  supabase = createClient(supabaseUrl, supabaseServiceKey);
  console.log("Supabase Admin Client initialized successfully.");
} else {
  console.warn("Warning: Supabase credentials missing from .env file!");
}

// Initialize Groq SDK
const groqApiKey = process.env.GROQ_API_KEY;
let groq = null;

if (groqApiKey) {
  groq = new Groq({ apiKey: groqApiKey });
  console.log("Groq Client initialized successfully.");
} else {
  console.warn("Warning: Groq API Key missing from .env file!");
}

// -------------------------------------------------------------
// SECURE CONFIG CONFIGURATION ENDPOINT
// -------------------------------------------------------------
app.get('/api/config', (req, res) => {
  res.json({
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY
  });
});

// -------------------------------------------------------------
// SECURE ADMIN TELEMETRY DATA PROXIES (Bypass Frontend RLS)
// -------------------------------------------------------------
app.get('/api/admin/users', async (req, res) => {
  const { adminEmail } = req.query;
  if (adminEmail !== 'zaidali332311@gmail.com') {
    return res.status(403).json({ error: "Access denied." });
  }
  try {
    if (!supabase) throw new Error("Supabase client not initialized.");
    const { data: profiles, error } = await supabase
      .from('profiles')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ profiles });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/analytics', async (req, res) => {
  const { adminEmail } = req.query;
  if (adminEmail !== 'zaidali332311@gmail.com') {
    return res.status(403).json({ error: "Access denied." });
  }
  try {
    if (!supabase) throw new Error("Supabase client not initialized.");

    // Fetch all profiles to map email addresses
    const { data: profiles } = await supabase.from('profiles').select('id, email');
    const profileMap = {};
    if (profiles) {
      profiles.forEach(p => {
        profileMap[p.id] = p.email;
      });
    }

    // Fetch all conversations to map conversation_id to user_id
    const { data: convs } = await supabase.from('conversations').select('id, user_id');
    const convUserMap = {};
    if (convs) {
      convs.forEach(c => {
        convUserMap[c.id] = c.user_id;
      });
    }

    // Fetch latest 150 messages from the database
    const { data: messages, error } = await supabase
      .from('messages')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(150);
    if (error) throw error;

    // Map each message to enrich it with user_id and user_email
    const enrichedMessages = messages.map(m => {
      const userId = convUserMap[m.conversation_id] || null;
      const userEmail = userId ? profileMap[userId] : 'anonymous';
      return {
        ...m,
        user_id: userId,
        user_email: userEmail
      };
    });

    res.json({ messages: enrichedMessages });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/stats', async (req, res) => {
  const { adminEmail } = req.query;
  if (adminEmail !== 'zaidali332311@gmail.com') {
    return res.status(403).json({ error: "Access denied." });
  }
  try {
    if (!supabase) throw new Error("Supabase client not initialized.");
    const { count: usersCount } = await supabase.from('profiles').select('*', { count: 'exact', head: true });
    const { data: allMessages } = await supabase.from('messages').select('content');
    const totalMsgs = allMessages ? allMessages.length : 0;
    const refusals = allMessages ? allMessages.filter(m => m.content && (m.content.includes("I am only authorized") || m.content.includes("dining experience"))).length : 0;
    res.json({ usersCount, totalMsgs, refusals });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// -------------------------------------------------------------
// DELETE CONVERSATION — user can delete their own chat threads
// -------------------------------------------------------------
app.delete('/api/chat/conversation/:convId', async (req, res) => {
  const { convId } = req.params;
  const { userId } = req.body;
  if (!convId || !userId) return res.status(400).json({ error: 'Missing convId or userId' });
  try {
    if (!supabase) throw new Error('Supabase not initialized');
    // Only allow deletion if the conversation belongs to this user
    const { data: conv, error: fetchErr } = await supabase
      .from('conversations')
      .select('id, user_id')
      .eq('id', convId)
      .single();
    if (fetchErr || !conv) return res.status(404).json({ error: 'Conversation not found' });
    if (conv.user_id !== userId) return res.status(403).json({ error: 'Not your conversation' });

    // Delete messages first (FK constraint)
    await supabase.from('messages').delete().eq('conversation_id', convId);
    // Delete conversation
    const { error: delErr } = await supabase.from('conversations').delete().eq('id', convId);
    if (delErr) throw delErr;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// SAVE INSTRUCTIONS — admin upsert system prompt
// -------------------------------------------------------------
app.post('/api/admin/instructions', async (req, res) => {
  const { adminEmail, instructions } = req.body;
  if (adminEmail !== 'zaidali332311@gmail.com') return res.status(403).json({ error: 'Access denied' });
  if (!instructions) return res.status(400).json({ error: 'Missing instructions' });
  try {
    if (!supabase) throw new Error('Supabase not initialized');
    const { error } = await supabase
      .from('chat_settings')
      .upsert({ id: 1, instructions }, { onConflict: 'id' });
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// SECURE CHAT ENDPOINT (Calling Groq with Strict Prompt Control)
// -------------------------------------------------------------
app.post('/api/chat', async (req, res) => {
  const { message, userId, userEmail, conversationId } = req.body;

  if (!message || !userId || !userEmail) {
    return res.status(400).json({ error: "Missing required chat parameters." });
  }

  try {
    // 1. Fetch the latest strict chatbot instructions from Supabase
    let systemInstructions = `You are a highly professional, strict, and welcoming AI chatbot for "Kolachi Restaurant" located at Beach Avenue, Phase VIII, DHA, Karachi, Pakistan.
Kolachi is famous for its gorgeous wooden deck over the Arabian Sea, premium oceanfront dining vibe, and authentic Pakistani gourmet cuisine.
You must ONLY answer questions regarding Kolachi Restaurant (location, timings, signature menu items, pricing, seating, and reservation policies).
Do NOT talk about general topics, coding, math, translation, history, or other restaurants.
If a user asks something unrelated, reply exactly: "I am only authorized to answer questions regarding Kolachi Restaurant. How can I help you with your premium seaside dining experience today?"

Your rich database includes:
- Location: Beach Avenue, Spirit of Clifton Beach, Phase VIII, DHA, Karachi, Pakistan.
- Seating options: Outer seaward wooden deck (breathtaking waves view, requires 24-48 hours booking), inner premium air-conditioned family lounges.
- Operating hours: 5:00 PM to 1:00 AM daily (Dinner only).
- Signature Pakistani specialties:
  * Peshawari Karahi (prepared in pure ghee with tomatoes and green chilies) - Price: Rs. 2,400 per kg.
  * Hunza Kabab (tender lamb skewers seasoned with regional spices) - Price: Rs. 1,600.
  * Paneer Reshmi Handi (rich, creamy cottage cheese stew) - Price: Rs. 1,400.
  * Kolachi Sajji (traditional slow-roasted chicken Sajji stuffed with spiced rice) - Price: Rs. 1,800.
  * Sajji Fish (freshly caught red snapper slow-roasted over charcoal) - Price: Rs. 2,900.
  * Grilled Tiger Prawns (spiced ocean tiger prawns with butter-herb reduction) - Price: Rs. 3,200.
- Reservation Booking: Call +92-21-111-111-001 or email reservations@kolachi.pk. Bookings are open from 12:00 PM to 6:00 PM daily. Outer deck seating has Rs. 1,500 minimum spending per person on weekends.`;
    
    if (supabase) {
      const { data: settings } = await supabase
        .from('chat_settings')
        .select('instructions')
        .order('id', { ascending: false })
        .limit(1)
        .single();

      if (settings && settings.instructions) {
        systemInstructions = settings.instructions;
      }
    }

    // Append JSON formatting constraint to whatever instructions are active
    const finalSystemPrompt = systemInstructions + "\n\nCRITICAL: You MUST respond in a valid JSON object format containing a 'reply' string and an array of 3 follow-up 'suggestions' (clickable suggestions for the user to continue the conversation). Suggestions must be direct questions related to your reply or Kolachi's menu, reservations, and timings.\nExample Format:\n{\n  \"reply\": \"Welcome to Kolachi! We offer the finest Peshawari Karahi in Karachi.\",\n  \"suggestions\": [\"What is on the Karahi menu?\", \"Can I book a seaside deck table?\", \"What are your operating hours?\"]\n}";

    // 2. Fetch the last 10 messages from this conversation's context history if activeConvId is provided
    let history = [];
    let activeConvId = conversationId;
 
    if (supabase && activeConvId) {
      const { data: oldMessages } = await supabase
        .from('messages')
        .select('role, content')
        .eq('conversation_id', activeConvId)
        .order('created_at', { ascending: true })
        .limit(10);
 
      if (oldMessages) {
        history = oldMessages.map(m => ({
          role: m.role,
          content: m.content
        }));
      }
    }

    // 3. Assemble full system + history + new prompt
    const messagesPayload = [
      { role: 'system', content: finalSystemPrompt },
      ...history,
      { role: 'user', content: message }
    ];

    let rawReply = "I am having trouble computing an intelligence response at the moment. Please try again.";
    let parsedReplyText = "";
    let suggestionsArray = [
      "What is on the menu?",
      "Can I book a table?",
      "What are your timings?"
    ];

    // 4. Call Groq for lightning-fast strict inference
    if (groq) {
      const chatCompletion = await groq.chat.completions.create({
        messages: messagesPayload,
        model: 'llama-3.3-70b-versatile',
        temperature: 0.1 // very low temperature ensures absolute strictness
      });

      if (chatCompletion.choices && chatCompletion.choices[0]) {
        rawReply = chatCompletion.choices[0].message.content.trim();
      }
    } else {
      rawReply = JSON.stringify({
        reply: "[Simulated Mode] Welcome to Kolachi Karachi! We offer traditional Peshawari Karahi, slow-roasted Sajji, and stunning sea views on Clifton Beach.",
        suggestions: ["Show me the kebab menu", "How can I book an outdoor deck table?", "What are your reservation contact details?"]
      });
    }

    // Safely parse JSON reply and suggestions
    try {
      const parsed = JSON.parse(rawReply);
      parsedReplyText = parsed.reply || rawReply;
      suggestionsArray = parsed.suggestions || suggestionsArray;
    } catch (jsonErr) {
      parsedReplyText = rawReply;
      // Dynamically deduce 3 relevant suggestions if parser fails
      if (rawReply.toLowerCase().includes("reserv") || rawReply.toLowerCase().includes("deck") || rawReply.toLowerCase().includes("seat")) {
        suggestionsArray = ["How do I make a reservation?", "What is your outdoor deck seating capacity?", "Can I walk-in for a table?"];
      } else if (rawReply.toLowerCase().includes("menu") || rawReply.toLowerCase().includes("eat") || rawReply.toLowerCase().includes("dish") || rawReply.toLowerCase().includes("karahi")) {
        suggestionsArray = ["Show me your signature kebabs", "Do you serve Peshawari Karahi?", "What seafood dishes do you have?"];
      } else {
        suggestionsArray = ["What is the story of Kolachi?", "What are your popular dishes?", "Where is Kolachi located in Karachi?"];
      }
    }

    // 5. Save user message and assistant reply to the Supabase database
    if (supabase) {
      if (!activeConvId) {
        // Create new conversation
        const titleText = message.substring(0, 30) + (message.length > 30 ? "..." : "");
        const { data: newConv, error: newConvErr } = await supabase.from('conversations').insert({
          user_id: userId,
          title: titleText,
          model: "llama-3.3-70b-versatile"
        }).select().single();
        
        if (newConvErr) {
          console.error("Failed to create conversation:", newConvErr.message);
        } else if (newConv) {
          activeConvId = newConv.id;
        }
      } else {
        // Update updated_at timestamp of conversation to bubble it up
        await supabase.from('conversations').update({ updated_at: new Date() }).eq('id', activeConvId);
      }

      if (activeConvId) {
        const { error: insErr } = await supabase.from('messages').insert([
          { conversation_id: activeConvId, role: 'user', content: message },
          { conversation_id: activeConvId, role: 'assistant', content: parsedReplyText }
        ]);
        if (insErr) {
          console.error("Failed to insert messages under conversation:", insErr.message);
        }
      }
    }

    // 6. Return response to client with suggestions and active conversationId
    res.json({ reply: parsedReplyText, suggestions: suggestionsArray, conversationId: activeConvId });

  } catch (err) {
    console.error("Secure chat execution error:", err.message);
    res.status(500).json({ error: "Failed to generate AI completions." });
  }
});

// -------------------------------------------------------------
// CLEAN ROUTING TO TEMPLATE SCREEN ASSETS
// -------------------------------------------------------------
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/signup', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'signup.html'));
});

app.get('/forgot-password', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'forgot-password.html'));
});

app.get('/chat', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'chat.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/admin-users', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-users.html'));
});

app.get('/admin-analytics', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-analytics.html'));
});

app.get('/history', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'history.html'));
});

app.get('/settings', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'settings.html'));
});

app.get('/terms', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'terms.html'));
});

app.get('/privacy', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'privacy.html'));
});

// Root: serve the Kolachi Restaurant homepage
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/home', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start the server
if (process.env.NODE_ENV !== 'production' || !process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Kolachi Restaurant full application running at http://localhost:${PORT}/`);
  });
}

module.exports = app;
