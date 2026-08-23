/**
 * Nigeria Mosaic - Central Event Configuration
 * 
 * Update these settings to customize the event experience.
 * All settings are centralized here for easy deployment and modification.
 */

window.APP_CONFIG = {
  // ==========================================
  // 1. EVENT QUESTION & BRANDING
  // ==========================================
  // The arrival question displayed on attendees' phones
  QUESTION_TEXT: "What makes you proud to be Nigerian?",
  
  // Subtitle / helper hint for attendees
  QUESTION_SUBTITLE: "Enter a single powerful word (e.g. Resilience, Culture, Music, Innovation, Hospitality)",
  
  // Event Title for Display Screen Header & Browser Title
  EVENT_TITLE: "NIGERIA MOSAIC",
  EVENT_SUBTITLE: "Live Attendee Word Cloud",

  // ==========================================
  // 2. SUPABASE CREDENTIALS
  // ==========================================
  // Replace these with your Supabase project URL and anon public key.
  // Obtain these from: Supabase Dashboard -> Project Settings -> API
  SUPABASE_URL: "https://ptgrcseudavkaviwdgzo.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_GyaJRCIH81_tOYCTMF7jew_ZwvJU5EN",

  // Table name in Supabase
  TABLE_NAME: "responses",

  // ==========================================
  // 3. DISPLAY & PACKING BEHAVIOR
  // ==========================================
  // Full re-pack interval (number of new responses before a full smooth re-pack)
  REPACK_INTERVAL: 25,

  // Maximum characters allowed per single word
  MAX_WORD_LENGTH: 20,

  // Minimum and Maximum font sizes on the big screen (in pixels at 1920x1080)
  FONT_SIZE_MIN: 18,
  FONT_SIZE_MAX: 110,

  // Font family used for word cloud display
  FONT_FAMILY: "Outfit, 'Cabinet Grotesk', 'Inter', sans-serif",

  // Font weight
  FONT_WEIGHT: "800",

  // High-contrast color palette optimized for bright projector environments (Gold, White, Radiant Emerald, Warm Amber)
  COLOR_PALETTE: [
    "#FBBF24", // Brilliant Nigerian Gold
    "#FFFFFF", // Crisp Pure White
    "#10B981", // High-Contrast Modern Emerald
    "#F59E0B", // Radiant Deep Gold
    "#F3F4F6", // Platinum White
    "#34D399", // Vibrant Mint Emerald
    "#FCD34D", // Sunlit Gold
    "#D97706", // Deep Solar Amber
    "#E5E7EB", // Bright Silver
    "#059669"  // Solid Forest Emerald
  ],

  // Ambient motion duration (seconds for the subtle highlight/glow to cycle across words)
  AMBIENT_CYCLE_SECONDS: 12,

  // ==========================================
  // 4. ADMIN & MODERATION
  // ==========================================
  // Simple PIN for on-site admin access protection (set to empty "" to disable PIN prompt)
  ADMIN_PIN: "1960",

  // Profanity Blocklist (Silent drop or flag of inappropriate terms)
  // Expand this list as needed for your specific event context.
  PROFANITY_BLOCKLIST: [
    "badword", "idiot", "fool", "scam", "scammer", "hate", "kill", "die",
    "stupid", "fraud", "corrupt", "thief", "nonsense", "rubbish", "bitch",
    "bastard", "fuck", "shit", "ass", "dick", "cunt", "pussy", "sex", "porn"
  ]
};
