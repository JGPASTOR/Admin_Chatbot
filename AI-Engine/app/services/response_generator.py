"""Template-based response generator with topic-aware response variation."""

import random
from typing import Dict, Any, Optional


# ── Topic-selection welcome messages ──────────────────────────────────────────
_TOPIC_WELCOME_DOCS = [
    (
        "📄 **Document Tracking Mode**\n\n"
        "You're now in **Document Tracking** mode. I can help you check the real-time status of your documents.\n\n"
        "**How to get started:**\n"
        "- Tell me your **Tracking No.** (e.g., *\"PDID 001\"* or just *\"001\"*)\n"
        "- Or ask something like *\"Where is my document?\"*\n\n"
        "What document would you like to track?"
    ),
    (
        "🔍 **Document Tracking Mode Active**\n\n"
        "Great choice! I'll help you track your documents through the city's Document Tracking System.\n\n"
        "Simply provide your **Tracking No.** and I'll pull up the latest status, current location, "
        "and route history of your document.\n\n"
        "Go ahead — what's your Tracking No.?"
    ),
]

_TOPIC_WELCOME_LGU = [
    (
        "🏛️ **General Services Mode**\n\n"
        "You're now in **General Services** mode. I can answer questions about:\n\n"
        "- 📋 **City programs & services** — permits, clearances, requirements\n"
        "- 🏛️ **Local Government** — offices, officials, city ordinances\n"
        "- 📍 **Tourism** — tourist spots, festivals, places to visit\n"
        "- 📄 **Document requirements** — what papers you need and where to get them\n\n"
        "What would you like to know about Surigao City?"
    ),
    (
        "🏛️ **General Services Mode Active**\n\n"
        "Welcome! I'm ready to assist you with general inquiries about the "
        "City Government of Surigao City.\n\n"
        "Feel free to ask me about city services, LGU programs, tourist attractions, "
        "government offices, or any document requirements.\n\n"
        "How can I help you today?"
    ),
]

_TOPIC_WELCOME_LGU_TL = [
    (
        "🏛️ **General Services Mode**\n\n"
        "Nasa **General Services** mode ka na. Maaari akong sumagot ng mga katanungan tungkol sa:\n\n"
        "- 📋 **Mga programa at serbisyo ng lungsod** — permit, clearance, mga kinakailangan\n"
        "- 🏛️ **Lokal na Pamahalaan** — mga opisina, opisyal, ordinansa ng lungsod\n"
        "- 📍 **Turismo** — mga turistang lugar, pista, mga puwedeng bisitahin\n"
        "- 📄 **Mga kinakailangang dokumento** — anong papel ang kailangan at saan makukuha\n\n"
        "Ano ang gusto mong malaman tungkol sa Surigao City?"
    ),
    (
        "🏛️ **General Services Mode Active**\n\n"
        "Maligayang pagdating! Handa akong tumulong sa iyong mga katanungan tungkol sa "
        "Pamahalaan ng Lungsod ng Surigao City.\n\n"
        "Huwag mahiyang magtanong tungkol sa mga serbisyo ng lungsod, mga programa ng LGU, "
        "mga tourist na lugar, opisina ng pamahalaan, o anumang kinakailangang dokumento.\n\n"
        "Paano kita matutulungan ngayon?"
    ),
]


# ── Greeting responses ────────────────────────────────────────────────────────
_GREETING_DOCS = [
    "Hello! 👋 You're in **Document Tracking** mode. Just give me your Tracking No. and I'll pull up your document's latest status right away!",
    "Hi there! 😊 Ready to help you track your documents. Share your **Tracking No.** (e.g., *\"PDID 001\"*) and I'll get the status for you.",
    "Hey! 👋 Welcome back! I'm here to help you track your documents. What's your Tracking No.?",
    "Hello! 😊 I'm your Document Tracking Assistant. Provide your **PDID number** and I'll show you where your document is right now.",
    "Hi! 👋 Good to hear from you. Drop your Tracking No. and I'll check the status of your document instantly.",
]

_GREETING_LGU = [
    "Hello! 👋 You're in **General Services** mode. I can help with city services, LGU programs, permits, tourism questions, and more. What would you like to know about Surigao City?",
    "Hi there! 😊 Welcome! I'm here to assist you with general inquiries about the City Government of Surigao. Ask me anything — services, offices, requirements, or tourist spots!",
    "Hey! 👋 Ready to assist! Whether it's a permit, clearance, or tourism question, I've got you covered. What can I help you with today?",
    "Hello! 😊 I'm your General Services Assistant for Surigao City. What information can I provide for you?",
    "Hi! 👋 Great to have you here. I can answer questions about city programs, LGU services, and local tourism. What would you like to know?",
]

_GREETING_LGU_TL = [
    "Kamusta! 👋 Nasa **General Services** mode ka. Makakatulong ako sa mga serbisyo ng lungsod, programa ng LGU, permit, tanong sa turismo, at iba pa. Ano ang gusto mong malaman tungkol sa Surigao City?",
    "Helo! 😊 Maligayang pagdating! Nandito ako para tumulong sa iyong mga katanungan tungkol sa Pamahalaan ng Surigao. Magtanong ka — serbisyo, opisina, kinakailangan, o mga tourist spot!",
    "Hoy! 👋 Handa akong tumulong! Kahit permit, clearance, o tanong sa turismo, nandito ako para sa iyo. Paano kita matutulungan ngayon?",
    "Kamusta! 😊 Ako ang iyong General Services Assistant para sa Surigao City. Anong impormasyon ang kailangan mo?",
    "Hi! 👋 Masaya kang naroon. Makakatulong ako sa mga tanong tungkol sa mga programa ng lungsod, serbisyo ng LGU, at lokal na turismo. Ano ang gusto mong malaman?",
]

_GREETING_DEFAULT = [
    "Hello! 👋 I'm the DTS AI Assistant — built by Clarence Buenaflor, Jester Pastor & Mharjade Enario. I can help you check the status of your documents. Just ask me about your document or provide a Tracking No.!",
    "Hi there! 😊 Welcome to the DTS AI Engine. How can I help you today? You can ask me to check your document status or provide a Tracking No.",
    "Hey! 👋 I'm the DTS AI — and I'm here to help you track your documents. Just give me your Tracking No. or ask about your document status!",
]


# ── Thanks responses ──────────────────────────────────────────────────────────
_THANKS_DOCS = [
    "You're welcome! 😊 If you have more documents to track, just give me another Tracking No.",
    "No problem at all! 👍 Feel free to come back anytime you need to check a document status.",
    "Glad I could help! 😊 If there's another document you'd like to track, just say the word.",
    "Happy to assist! Let me know if you need to follow up on any other documents.",
    "Of course! 😊 Don't hesitate to check back whenever you need a document status update.",
]

_THANKS_LGU = [
    "You're welcome! 😊 If you have more questions about Surigao City services, feel free to ask.",
    "No problem! 👍 I'm always here if you need more information about the city's programs or services.",
    "Glad I could help! 😊 Don't hesitate to ask if you need more details on any LGU services.",
    "Happy to assist! Let me know if you'd like to know more about permits, tourism, or city programs.",
    "Of course! 😊 Come back anytime you need information about Surigao City.",
]

_THANKS_LGU_TL = [
    "Walang anuman! 😊 Kung mayroon ka pang mga katanungan tungkol sa mga serbisyo ng Surigao City, huwag mahiyang magtanong.",
    "Walang problema! 👍 Nandito ako palagi kung kailangan mo ng karagdagang impormasyon tungkol sa mga programa o serbisyo ng lungsod.",
    "Natutuwa akong nakatulong! 😊 Huwag mag-alinlangang magtanong kung kailangan mo ng karagdagang detalye tungkol sa mga serbisyo ng LGU.",
    "Nagagalak akong tumulong! Ipaalam mo sa akin kung gusto mong malaman pa ang tungkol sa permit, turismo, o mga programa ng lungsod.",
    "Syempre! 😊 Bumalik ka anumang oras kung kailangan mo ng impormasyon tungkol sa Surigao City.",
]

_THANKS_DEFAULT = [
    "You're welcome! 😊 If you need anything else, feel free to ask.",
    "No problem! Happy to help. Let me know if you need to check another document.",
    "Glad I could help! 😊 Don't hesitate to come back if you need anything.",
    "You're welcome! If you have more documents to check, just provide another Tracking No.",
    "Anytime! 😊 I'm here whenever you need assistance.",
]


# ── Goodbye responses ─────────────────────────────────────────────────────────
_GOODBYE_DOCS = [
    "Goodbye! 👋 Come back anytime you need to track your documents.",
    "See you! 👋 I'll be here whenever you need to check a document status.",
    "Take care! 😊 Don't hesitate to return if you need to follow up on a document.",
    "Bye! 👋 Have a great day ahead — I'm here whenever you need document tracking.",
    "Goodbye! 😊 Remember, you can check your documents anytime by providing your Tracking No.",
]

_GOODBYE_LGU = [
    "Goodbye! 👋 Feel free to come back if you have more questions about Surigao City services.",
    "See you! 👋 I'm always here to help with city programs, permits, and tourism questions.",
    "Take care! 😊 Don't hesitate to return if you need more information about LGU services.",
    "Bye! 👋 Have a wonderful day! Come back anytime for city service inquiries.",
    "Goodbye! 😊 Surigao City is always here to serve you. Have a great day!",
]

_GOODBYE_LGU_TL = [
    "Paalam! 👋 Bumalik ka kung mayroon ka pang mga katanungan tungkol sa mga serbisyo ng Surigao City.",
    "Hanggang sa muli! 👋 Lagi akong nandito para tumulong sa mga programa ng lungsod, permit, at mga tanong sa turismo.",
    "Ingat! 😊 Huwag mag-alinlangang bumalik kung kailangan mo ng karagdagang impormasyon tungkol sa mga serbisyo ng LGU.",
    "Bye! 👋 Magkaroon ng magandang araw! Bumalik anumang oras para sa mga katanungan tungkol sa serbisyo ng lungsod.",
    "Paalam! 😊 Lagi itong nakabukas para sa iyo. Magkaroon ng magandang araw!",
]

_GOODBYE_DEFAULT = [
    "Goodbye! 👋 Have a great day!",
    "See you! 👋 Don't hesitate to come back if you need help with your documents.",
    "Take care! 😊 I'll be here whenever you need to track a document.",
    "Bye! 👋 Have a wonderful day ahead!",
    "Goodbye! 😊 Stay safe and come back anytime!",
]


# ── Help responses ────────────────────────────────────────────────────────────
_HELP_DOCS = (
    "🤖 **DTS AI Engine v1.0** — *Built by Clarence Buenaflor, Jester Pastor & Mharjade Enario*\n\n"
    "You're in **Document Tracking** mode. Here's how I can help:\n\n"
    "📄 **Check Document Status** — Ask *\"What is the status of my document?\"* and I'll look it up.\n\n"
    "🔍 **Track by Tracking No.** — Just type your Tracking No. (e.g., *\"PDID 001\"* or *\"001\"*) "
    "and I'll fetch the latest status, current office, and route history.\n\n"
    "🔄 **Follow Up** — If you've previously asked about a document, I'll remember the context for follow-up questions.\n\n"
    "Just type your question or Tracking No. and I'll take it from there!"
)

_HELP_LGU = (
    "🤖 **DTS AI Engine v1.0** — *Built by Clarence Buenaflor, Jester Pastor & Mharjade Enario*\n\n"
    "You're in **General Services** mode. Here's what I can help you with:\n\n"
    "🏛️ **LGU Programs & Services** — Ask about city programs, the Executive Legislative Agenda, or local ordinances.\n\n"
    "📋 **Permits & Requirements** — Ask what you need for a business permit, mayor's clearance, or other city documents.\n\n"
    "📍 **Tourism** — Discover tourist spots, festivals, and places to visit in Surigao City.\n\n"
    "👤 **City Officials** — Ask about the mayor, city offices, or government departments.\n\n"
    "Just type your question and I'll do my best to assist you!"
)

_HELP_LGU_TL = (
    "🤖 **DTS AI Engine v1.0** — *Ginawa nina Clarence Buenaflor, Jester Pastor at Mharjade Enario*\n\n"
    "Nasa **General Services** mode ka. Narito ang aking maitutulong:\n\n"
    "🏛️ **Mga Programa at Serbisyo ng LGU** — Magtanong tungkol sa mga programa ng lungsod, Executive Legislative Agenda, o lokal na ordinansa.\n\n"
    "📋 **Permit at mga Kinakailangan** — Magtanong kung ano ang kailangan para sa business permit, mayor's clearance, o ibang dokumento ng lungsod.\n\n"
    "📍 **Turismo** — Tuklasin ang mga tourist spot, pista, at mga lugar na dapat bisitahin sa Surigao City.\n\n"
    "👤 **Mga Opisyal ng Lungsod** — Magtanong tungkol sa mayor, mga opisina ng lungsod, o mga departamento ng pamahalaan.\n\n"
    "I-type lang ang iyong katanungan at gagawin ko ang lahat para matulungan ka!"
)

_HELP_DEFAULT = (
    "🤖 **DTS AI Engine v1.0** — *Built by Clarence Buenaflor, Jester Pastor & Mharjade Enario*\n\n"
    "Here's how I can help you:\n\n"
    "📄 **Check Document Status** — Ask me something like *\"What is the status of my document?\"* "
    "and I'll look it up for you.\n\n"
    "🔍 **Track by Tracking No.** — If you know your document's Tracking No., just say *\"1000\"* "
    "and I'll fetch the latest status.\n\n"
    "Just type your question and I'll do my best to assist you!"
)


# ── Complaint responses ───────────────────────────────────────────────────────
_COMPLAINT_DOCS = [
    (
        "I'm sorry to hear you're having trouble with your document. 😔\n\n"
        "I can check the **current status** right now — just provide your **Tracking No.** and I'll see where your document is and who's handling it.\n\n"
        "If you'd like to formally escalate your concern, please visit the **DTS Office** or contact the **City Administrator's Office** directly."
    ),
    (
        "I understand your frustration, and I sincerely apologize for the delay. 🙏\n\n"
        "Let me help by checking your document's latest status — please share your **Tracking No.** "
        "and I'll show you exactly where it is and what action is being taken.\n\n"
        "For formal complaints, you may also reach out to the **City Administrator's Office**."
    ),
    (
        "I'm really sorry to hear that. 😔 I know waiting is frustrating, especially for important documents.\n\n"
        "Give me your **Tracking No.** and I'll tell you the current location of your document and who's responsible for it.\n\n"
        "You may also want to visit the **DTS Office** in person to follow up directly."
    ),
]

_COMPLAINT_LGU = [
    (
        "I'm sorry to hear you're having a difficult experience with city services. 😔\n\n"
        "While I can provide general information about LGU services and programs, for formal complaints "
        "or concerns, I recommend reaching out to the **City Administrator's Office** or visiting **City Hall**.\n\n"
        "Is there specific information about a service or office I can help you with?"
    ),
    (
        "I understand your concern, and I'm sorry for any inconvenience. 🙏\n\n"
        "For service-related complaints, please contact the relevant city department directly or visit the **City Hall**. "
        "I can help you find the right office or department to address your concern.\n\n"
        "What service or department is your concern about?"
    ),
    (
        "I'm sorry to hear that. 😔 Your concern is important and deserves proper attention.\n\n"
        "I recommend visiting the **City Hall** or contacting the **City Administrator's Office** to formally raise your complaint. "
        "I can provide information on what service or office you need — just let me know."
    ),
]

_COMPLAINT_LGU_TL = [
    (
        "Natutuwa akong gawin — ay, ikinalulungkot ko ang iyong masamang karanasan sa mga serbisyo ng lungsod. 😔\n\n"
        "Habang makakapagbigay ako ng pangkalahatang impormasyon tungkol sa mga serbisyo at programa ng LGU, para sa mga pormal na reklamo "
        "o alalahanin, inirerekomenda ko na makipag-ugnayan sa **City Administrator's Office** o bisitahin ang **City Hall**.\n\n"
        "Mayroon bang tukoy na impormasyon tungkol sa isang serbisyo o opisina na makakatulong ako?"
    ),
    (
        "Naiintindihan ko ang iyong alalahanin, at ikinalulungkot ko ang anumang abala. 🙏\n\n"
        "Para sa mga reklamo na may kaugnayan sa serbisyo, mangyaring makipag-ugnayan nang direkta sa kaugnay na departamento ng lungsod o bisitahin ang **City Hall**. "
        "Makakatulong ako sa paghahanap ng tamang opisina o departamento para matugunan ang iyong alalahanin.\n\n"
        "Anong serbisyo o departamento ang iyong alalahanin?"
    ),
    (
        "Ikinalulungkot ko iyon. 😔 Mahalaga ang iyong alalahanin at nararapat itong matugunan nang maayos.\n\n"
        "Inirerekomenda ko na bisitahin ang **City Hall** o makipag-ugnayan sa **City Administrator's Office** para pormal na itaas ang iyong reklamo. "
        "Makakapagbigay ako ng impormasyon kung aling serbisyo o opisina ang kailangan mo — sabihin mo lang."
    ),
]

_COMPLAINT_DEFAULT = [
    (
        "I'm sorry to hear you're having trouble with your document. "
        "If you'd like, I can check the current status of your document — just provide your PDID number.\n\n"
        "If you wish to formally file a complaint or escalate your concern, "
        "please visit the DTS office or contact the City Administrator's Office for assistance."
    ),
    (
        "I understand your frustration, and I'm sorry for the inconvenience. "
        "I can help by checking the latest status of your document — just give me the Tracking No.\n\n"
        "For formal complaints, please reach out to the City Administrator's Office."
    ),
]


# ── LGU responses ─────────────────────────────────────────────────────────────
_LGU_RESPONSES = [
    "The City Government of Surigao is committed to providing efficient, transparent, and responsive public service. For specific inquiries about city ordinances, mayor's office programs, or local government services, you can visit the official Surigao City website or the City Hall.",
    "Surigao City, known as the 'City of Island Adventures,' is governed by dedicated local officials focused on sustainable development and public welfare. If you need details on specific LGU programs, I recommend contacting the City Information Office.",
    (
        "The Local Government Unit (LGU) of Surigao City offers a wide range of services including:\n\n"
        "- 📋 **Business Permits & Licensing**\n"
        "- 🏥 **Health & Social Services**\n"
        "- 🏗️ **Infrastructure & Public Works**\n"
        "- 📚 **Education Support Programs**\n"
        "- 🌿 **Environmental Management**\n\n"
        "Visit the City Hall or the official Surigao City website for more details."
    ),
]


# ── Tourism responses ─────────────────────────────────────────────────────────
_TOURISM_RESPONSES = [
    (
        "Surigao City is famous for its beautiful islands and beaches! 🌊\n\n"
        "**Top tourist spots include:**\n"
        "- 🪨 **Mabua Pebble Beach** — unique stone shoreline\n"
        "- 🌿 **Day-asan Floating Village** — scenic mangrove community\n"
        "- 💧 **Songkoy Cold Spring** — refreshing natural spring\n"
        "- 🏝️ **Island Hopping** — Basul, Silop, and nearby islands\n\n"
        "It's truly the City of Island Adventures! 🌴"
    ),
    "Looking for places to visit in Surigao? You shouldn't miss Mabua Pebble Beach for its unique stone shoreline, the mangrove forests of Day-asan Floating Village, or island hopping around the city. Don't forget to try the local seafood! 🦞",
    (
        "Surigao City has so much to offer for tourists! 🌴\n\n"
        "**Must-visit spots:**\n"
        "- 🪨 **Mabua Pebble Beach** — famous for its natural stone beach\n"
        "- 🚤 **Island Hopping** — explore the beautiful surrounding islands\n"
        "- 🌿 **Day-asan Floating Village** — unique floating community on mangroves\n"
        "- 🎉 **Bonok-Bonok Mardi Gras** — the city's colorful annual festival\n\n"
        "Would you like to know more about any specific spot?"
    ),
]


# ── Unknown / fallback responses ──────────────────────────────────────────────
_UNKNOWN_DOCS = [
    (
        "I'm sorry, I didn't catch that. 🤔 In **Document Tracking** mode, I can help you:\n\n"
        "- Check your document status\n"
        "- Track your document by Tracking No.\n\n"
        "Try asking *\"Where is my document?\"* or just type your **Tracking No.**"
    ),
    (
        "Hmm, I didn't quite understand that. I'm currently in **Document Tracking** mode.\n\n"
        "You can ask me things like:\n"
        "- *\"What is the status of my document?\"*\n"
        "- *\"PDID 001\"* — to track a specific document\n\n"
        "What's your Tracking No.?"
    ),
    (
        "I'm not sure I understood that. 🤔 In this mode, I specialize in **document tracking**.\n\n"
        "Please provide your **Tracking No.** or ask me about your document status."
    ),
]

_UNKNOWN_LGU = [
    (
        "I'm sorry, I didn't quite understand that. 🤔 In **General Services** mode, I can help you with:\n\n"
        "- 🏛️ City programs and LGU services\n"
        "- 📋 Permit and document requirements\n"
        "- 📍 Tourist spots and festivals\n\n"
        "Try asking *\"What are the requirements for a business permit?\"* or *\"Where can I find tourist spots?\"*"
    ),
    (
        "Hmm, I'm not sure about that one. I can help with **Surigao City LGU services** — "
        "such as permits, ordinances, offices, or general inquiries.\n\n"
        "Try asking something like *\"What are the requirements for a business permit?\"* or "
        "*\"Where is the City Hall located?\"*"
    ),
    (
        "I didn't catch that. 🤔 In General Services mode, I can answer questions about city programs, "
        "services, offices, and tourism in Surigao City.\n\n"
        "What would you like to know?"
    ),
]

_UNKNOWN_LGU_TL = [
    (
        "Pasensya na, hindi ko maintindihan iyon. 🤔 Sa **General Services** mode, makakatulong ako sa:\n\n"
        "- 🏛️ Mga programa ng lungsod at serbisyo ng LGU\n"
        "- 📋 Mga kinakailangan para sa permit at dokumento\n"
        "- 📍 Mga tourist spot at pista\n\n"
        "Subukang magtanong ng *\"Ano ang mga kinakailangan para sa business permit?\"* o *\"Saan makikita ang mga tourist spot?\"*"
    ),
    (
        "Hmm, hindi ako sigurado doon. Makakatulong ako sa **mga serbisyo ng LGU ng Surigao City** — "
        "tulad ng permit, ordinansa, opisina, o pangkalahatang katanungan.\n\n"
        "Subukang magtanong ng *\"Ano ang mga kinakailangan para sa business permit?\"* o "
        "*\"Saan matatagpuan ang City Hall?\"*"
    ),
    (
        "Hindi ko narinig iyon nang maayos. 🤔 Sa General Services mode, makakatulong ako sa mga katanungan tungkol sa mga programa ng lungsod, "
        "serbisyo, opisina, at turismo sa Surigao City.\n\n"
        "Ano ang gusto mong malaman?"
    ),
]

_UNKNOWN_DEFAULT = [
    (
        "I'm sorry, I didn't understand that. I'm a Document Tracking Assistant — "
        "I can help you check the status of your documents. "
        "Try asking something like *\"What is the status of my document?\"* or provide a Tracking No."
    ),
    (
        "I'm not sure I understood that. 🤔 I specialize in document tracking for the City of Surigao.\n\n"
        "Try asking *\"Where is my document?\"* or provide your **Tracking No.**"
    ),
]


# ─────────────────────────────────────────────────────────────────────────────
#  Public API
# ─────────────────────────────────────────────────────────────────────────────

def generate_topic_welcome(topic: str, language: str = "en") -> str:
    """
    Return a welcome message when the user first selects a topic mode.

    Args:
        topic:    'docs' for Document Tracking, 'lgu' for General Services
        language: 'en' for English (default), 'tl' for Filipino/Tagalog

    Returns:
        A contextual welcome string for the selected mode.
    """
    if topic == "docs":
        return random.choice(_TOPIC_WELCOME_DOCS)
    if topic == "lgu":
        if language == "tl":
            return random.choice(_TOPIC_WELCOME_LGU_TL)
        return random.choice(_TOPIC_WELCOME_LGU)
    return random.choice(_GREETING_DEFAULT)


def generate_response(
    intent: str,
    entities: Dict[str, str],
    document: Optional[Dict[str, Any]] = None,
    context: dict = None,
    topic: Optional[str] = None,
    language: str = "en",
    rag_context: Optional[str] = None,
) -> str:
    """
    Generate a human-friendly, topic-aware response.

    Responses vary based on both the classified intent AND the user's selected
    topic mode (docs / lgu / None), providing more contextual and helpful replies.

    Args:
        intent:   Classified intent label
        entities: Extracted entities (e.g., {"pdid": "001"})
        document: Parsed document data from DTS API (or None)
        context:  Session context for multi-turn awareness
        topic:    User's selected mode — 'docs', 'lgu', or None
        language: Response language — 'en' (default) or 'tl' (Filipino/Tagalog)

    Returns:
        A human-readable response string.
    """

    # ── Hard override: document found → always show the status card ──────────
    if document:
        return _format_document_status(document)

    # ── PDID provided but not found ──────────────────────────────────────────
    if "pdid" in entities and document is None:
        pdid = entities["pdid"]
        return (
            f"I couldn't find any document with Tracking No. **{pdid}**. 🔍\n\n"
            "Please double-check the Tracking No. and try again, or contact the DTS Office if the issue persists."
        )

    # ── Document status (no PDID yet) ────────────────────────────────────────
    if intent == "document_status" and "pdid" not in entities:
        if topic == "lgu":
            return (
                "It looks like you might be asking about a specific document. "
                "If you'd like to track a document, please switch to **Document Tracking** mode and provide your Tracking No.\n\n"
                "Is there something else about city services I can help you with?"
            )
        return "I can help you check your document status. 📄 What is the **Tracking No.** of your document?"

    # ── Follow-up (no PDID yet) ──────────────────────────────────────────────
    if intent == "follow_up" and "pdid" not in entities:
        return "I didn't catch the Tracking No. 🤔 Could you please provide the **Tracking No.** of the document you want to check?"

    # ── Greeting ─────────────────────────────────────────────────────────────
    if intent == "greeting":
        if topic == "docs":
            return random.choice(_GREETING_DOCS)
        if topic == "lgu":
            if language == "tl":
                return random.choice(_GREETING_LGU_TL)
            return random.choice(_GREETING_LGU)
        return random.choice(_GREETING_DEFAULT)

    # ── Thanks ───────────────────────────────────────────────────────────────
    if intent == "thanks":
        if topic == "docs":
            return random.choice(_THANKS_DOCS)
        if topic == "lgu":
            if language == "tl":
                return random.choice(_THANKS_LGU_TL)
            return random.choice(_THANKS_LGU)
        return random.choice(_THANKS_DEFAULT)

    # ── Goodbye ──────────────────────────────────────────────────────────────
    if intent == "goodbye":
        if topic == "docs":
            return random.choice(_GOODBYE_DOCS)
        if topic == "lgu":
            if language == "tl":
                return random.choice(_GOODBYE_LGU_TL)
            return random.choice(_GOODBYE_LGU)
        return random.choice(_GOODBYE_DEFAULT)

    # ── RAG Fallback (LLM is down) ───────────────────────────────────────────
    # If the LLM is down but we found relevant document chunks, show only the
    # single most relevant chunk (first in the list — already ranked by score).
    # Showing all chunks produces unrelated sections that confuse the user.
    if rag_context:
        prefix = "📋 Here's what I found in our records:\n\n"
        if language == "tl":
            prefix = "📋 Narito ang nahanap ko sa aming mga rekord:\n\n"

        top_chunk = rag_context.split("\n\n---\n\n")[0].strip()
        return f"{prefix}{top_chunk}"

    # ── Help ─────────────────────────────────────────────────────────────────
    if intent == "help":
        if topic == "docs":
            return _HELP_DOCS
        if topic == "lgu":
            if language == "tl":
                return _HELP_LGU_TL
            return _HELP_LGU
        return _HELP_DEFAULT

    # ── Complaint ─────────────────────────────────────────────────────────────
    if intent == "complaint":
        if topic == "docs":
            return random.choice(_COMPLAINT_DOCS)
        if topic == "lgu":
            if language == "tl":
                return random.choice(_COMPLAINT_LGU_TL)
            return random.choice(_COMPLAINT_LGU)
        return random.choice(_COMPLAINT_DEFAULT)

    # ── LGU Query ─────────────────────────────────────────────────────────────
    if intent == "lgu_query":
        return random.choice(_LGU_RESPONSES)

    # ── Tourism Query ─────────────────────────────────────────────────────────
    if intent == "tourism_query":
        return random.choice(_TOURISM_RESPONSES)

    # ── Unknown / fallback ────────────────────────────────────────────────────
    if topic == "docs":
        return random.choice(_UNKNOWN_DOCS)
    if topic == "lgu":
        if language == "tl":
            return random.choice(_UNKNOWN_LGU_TL)
        return random.choice(_UNKNOWN_LGU)
    return random.choice(_UNKNOWN_DEFAULT)


# ─────────────────────────────────────────────────────────────────────────────
#  Internal helpers
# ─────────────────────────────────────────────────────────────────────────────

def _format_document_status(document: Dict[str, Any]) -> str:
    """Format parsed document data into a rich, readable response."""
    pdid = document.get("pdid", "N/A")
    title = document.get("title", "N/A")
    status = document.get("status", "N/A")
    current_office = document.get("current_office", "N/A")
    current_holder = document.get("current_holder", "N/A")
    current_action = document.get("current_action", "N/A")
    origin_office = document.get("origin_office", "N/A")
    created_by = document.get("created_by", "N/A")
    created_at = document.get("created_at", "N/A")
    total_time = document.get("total_time", "N/A")
    route_count = document.get("route_count", 0)
    is_completed = document.get("is_completed", False)

    status_icon = "✅" if is_completed else "🔄"

    response = (
        f"📄 **Document Status for PDID {pdid}**\n\n"
        f"• **Accountable:** {current_holder}\n"
        f"• **Title:** {title}\n"
        f"• **Status:** {status_icon} {status}\n"
        f"• **Current Location:** {current_office}\n"
        f"• **Current Action:** {current_action}\n"
        f"• **Origin Office:** {origin_office}\n"
        f"• **Created By:** {created_by}\n"
        f"• **Date Created:** {created_at}\n"
        f"• **Overall Days on Process:** {total_time}\n"
        f"• **Offices Visited:** {route_count}\n"
    )

    route_summary = document.get("route_summary", [])
    if route_summary:
        response += "\n📋 **Route History:**\n"
        for i, stop in enumerate(route_summary, 1):
            office = stop.get("office", "Unknown")
            holder = stop.get("holder", "N/A")
            action = stop.get("action", "N/A")
            date_out = stop.get("date_out", "")
            tat = stop.get("tat", "N/A")

            tat_str = f" [TAT: {tat.strip()}]" if tat and tat != "N/A" else ""

            if date_out == "Still here":
                response += f"  {i}. 📍 **{office}** — {action} (held by {holder}){tat_str} ← *Currently here*\n"
            else:
                response += f"  {i}. {office} — {action} (handled by {holder}){tat_str}\n"

    return response
