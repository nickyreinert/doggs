"""Fast, dependency-free category classifier for (mostly German) paperwork.

It is a multinomial Naive Bayes model whose starting knowledge comes from weighted
German keyword seeds. Every category the user assigns by hand (or via a rule) becomes
a training example, so the classifier adapts to the user's own archive over time.
Classifying a document takes a few milliseconds and needs no model download or GPU.
"""
import math
import re
import unicodedata
from collections import Counter

# Keyword syntax: "word" matches at the start of a word (so "rechnung" also hits
# "rechnungsnummer" but not "abrechnung"), "*word" matches anywhere (German compounds
# such as "haftpflichtversicherung"), "=word" matches the whole word only.
SEED_KEYWORDS = {
    "invoice": {
        "rechnung": 3, "rechnungsnummer": 3, "rechnungsbetrag": 3, "rechnungsdatum": 3, "invoice": 3,
        "gesamtbetrag": 2, "zahlbar": 2, "zahlungsziel": 2, "mahnung": 2, "gutschrift": 2, "nettobetrag": 2,
        "=mwst": 1, "faellig": 1, "lieferschein": 1, "bestellnummer": 1, "kundennummer": 1, "buchungsbestaetigung": 1, "bestellbestaetigung": 1,
        "receipt": 3, "quittung": 3, "kassenbon": 3, "=total": 1, "=amount": 1,
    },
    "banking": {
        "kontoauszug": 4, "girokonto": 3, "kontostand": 3, "dauerauftrag": 3, "tagesgeld": 3, "festgeld": 3,
        "kreditkartenabrechnung": 3, "kreditkarte": 2, "depot": 2, "wertpapier": 2, "darlehen": 2, "kontoeroeffnung": 3,
        "ueberweisung": 1, "sparkasse": 2, "volksbank": 2, "commerzbank": 2, "comdirect": 2, "postbank": 2,
        "deutsche bank": 2, "=dkb": 2, "=n26": 2, "=saldo": 1, "zinsen": 1,
    },
    "tax-office": {
        "finanzamt": 4, "steuerbescheid": 4, "einkommensteuer": 3, "steuererklaerung": 3, "steueridentifikationsnummer": 3,
        "steuernummer": 2, "=elster": 2, "voranmeldung": 2, "*steuerbescheid": 2, "lohnsteuerbescheinigung": 2,
        "festsetzung": 1, "veranlagung": 2, "kirchensteuer": 1,
    },
    "insurance": {
        "*versicherung": 2, "versicherungsschein": 3, "versicherungsnehmer": 3, "versicherungsnummer": 2,
        "schadennummer": 3, "schadensmeldung": 3, "*krankenversicherung": 2, "krankenkasse": 2, "haftpflicht": 2,
        "hausrat": 2, "beitragsanpassung": 3, "=aok": 2, "barmer": 2, "techniker krankenkasse": 2, "allianz": 1, "=huk": 1,
    },
    "contract": {
        "*vertrag": 2, "kuendigung": 3, "*vereinbarung": 2, "mietvertrag": 3, "arbeitsvertrag": 3, "kaufvertrag": 3,
        "vertragsbestaetigung": 3, "auftragsbestaetigung": 2, "laufzeit": 1, "=agb": 1, "unterschrift": 1, "angebot": 1,
    },
    "financial-document": {
        "gehaltsabrechnung": 4, "entgeltabrechnung": 4, "lohnabrechnung": 4, "verdienstabrechnung": 4, "auszahlungsbetrag": 3,
        "quittung": 3, "kassenbon": 3, "kaufbeleg": 3, "zahlungsbestaetigung": 2, "renteninformation": 3,
        "sozialversicherungsnachweis": 3, "zuwendungsbestaetigung": 3, "spendenquittung": 3, "dividende": 2,
        "jahresbescheinigung": 2, "=brutto": 1, "=beleg": 1,
    },
    "outgoing": {
        "abschlag": 3, "zaehlerstand": 3, "verbrauchsabrechnung": 3, "nebenkosten": 3, "betriebskosten": 3,
        "rundfunkbeitrag": 3, "jahresabrechnung": 2, "erdgas": 2, "*fernwaerme": 2, "mobilfunk": 2, "=kwh": 2,
        "=strom": 2, "*stromlieferung": 2, "=miete": 2, "vattenfall": 2, "naturstrom": 2, "eprimo": 2, "gasag": 2,
        "telekom": 1, "vodafone": 1, "=dsl": 1, "internet": 1,
    },
    "personal": {
        "*arzt": 2, "befund": 3, "diagnose": 2, "attest": 2, "patient": 2, "arbeitsunfaehigkeit": 3, "*zeugnis": 2,
        "*urkunde": 2, "personalausweis": 3, "reisepass": 3, "meldebescheinigung": 3, "impf": 2, "rezept": 2,
        "=kita": 2, "*schule": 1, "*therapie": 2, "krankenhaus": 2, "klinik": 2, "praxis": 1,
        "lebenslauf": 4, "bewerbung": 4, "=cv": 3, "=resume": 3, "anschreiben": 2, "berufserfahrung": 3,
        "werdegang": 2, "entgeltabrechnung": 6, "gehaltsabrechnung": 6, "lohnabrechnung": 6, "bruttoentgelt": 4, "arbeitsvertrag": 2,
    },
}

STOP_WORDS = set("""
aber alle allem allen aller alles als also am an ander andere anderem anderen anderer anderes auch auf aus bei bin bis bist
da damit dann das dass dein deine dem den der des dessen dich die dies diese diesem diesen dieser dieses dir doch dort du durch
ein eine einem einen einer eines einig er es etwas euer eure fuer gegen gewesen hab habe haben hat hatte hier hin hinter ich
ihm ihn ihnen ihr ihre im in indem ins ist jede jedem jeden jeder jedes jene jetzt kann kein keine koennen man manche mein meine
mich mir mit muss nach nicht nichts noch nun nur ob oder ohne sehr sein seine sich sie sind so solche soll sollte sondern sonst
ueber um und uns unser unter vom von vor war waren warum was weil welche wenn werde werden wie wieder will wir wird wo wollen
wurde zu zum zur zwar zwischen herr frau herrn sehr geehrte geehrter freundlichen gruessen mit bitte seite datum telefon
the and for with from this that your you are our not have has will page date
""".split())

ALPHA, SEED_SCALE, MAX_WORDS, MAX_FEATURE_COUNT = 0.5, 2.0, 400, 3
UNTRAINED = {"misc"}


def normalize(text):
    text = str(text or "").lower().replace("ä", "ae").replace("ö", "oe").replace("ü", "ue").replace("ß", "ss")
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    return re.sub(r"\s+", " ", text)


def keyword_pattern(keyword):
    if keyword.startswith("*"): return re.compile(re.escape(keyword[1:]))
    if keyword.startswith("="): return re.compile(r"\b" + re.escape(keyword[1:]) + r"\b")
    return re.compile(r"\b" + re.escape(keyword))


class FastClassifier:
    def __init__(self, categories, examples=(), seeds=None):
        """`examples` are (text, category) pairs the user confirmed, e.g. manual or rule assignments."""
        seeds = SEED_KEYWORDS if seeds is None else seeds
        self.categories = list(dict.fromkeys(categories))
        self.keywords = {}
        self.counts = {category: Counter() for category in self.categories}
        self.examples = Counter()
        for category in self.categories:
            category_seeds = dict(seeds.get(category, {}))
            if not category_seeds and category not in UNTRAINED:
                # Custom categories without seeds still match their own name (e.g. "kfz" or "steuer-2024").
                category_seeds = {part: 2 for part in normalize(category).replace("-", " ").split() if len(part) >= 4}
            for keyword, weight in category_seeds.items():
                self.keywords.setdefault(keyword, keyword_pattern(keyword))
                self.counts[category]["kw:" + keyword.lstrip("*=")] += weight * SEED_SCALE
        for text, category in examples:
            if category in self.counts:
                self.counts[category].update(self.features(text))
                self.examples[category] += 1
        self.vocabulary = set().union(*self.counts.values()) if self.counts else set()
        self.totals = {category: sum(counter.values()) for category, counter in self.counts.items()}

    def features(self, text):
        normalized = normalize(text)
        words = [word for word in re.findall(r"[a-z][a-z0-9]{2,}", normalized)[:MAX_WORDS] if word not in STOP_WORDS]
        features = Counter({word: min(count, MAX_FEATURE_COUNT) for word, count in Counter(words).items()})
        for keyword, pattern in self.keywords.items():
            hits = len(pattern.findall(normalized))
            if hits: features["kw:" + keyword.lstrip("*=")] = min(hits, MAX_FEATURE_COUNT)
        return features

    def scores(self, text):
        """Return {category: probability} over trained categories, or {} without usable evidence."""
        features = {feature: count for feature, count in self.features(text).items() if feature in self.vocabulary}
        candidates = [category for category in self.categories if self.totals.get(category)]
        if not features or not candidates: return {}
        size, total_examples = len(self.vocabulary), sum(self.examples.values())
        raw = {}
        for category in candidates:
            counter, denominator = self.counts[category], self.totals[category] + ALPHA * size
            prior = math.log((self.examples[category] + 1) / (total_examples + len(candidates)))
            raw[category] = prior + sum(count * math.log((counter[feature] + ALPHA) / denominator) for feature, count in features.items())
        peak = max(raw.values())
        exp = {category: math.exp(score - peak) for category, score in raw.items()}
        norm = sum(exp.values())
        return {category: value / norm for category, value in exp.items()}

    def predict(self, text, min_confidence=0.6):
        """Return (category, confidence); category is "" when the evidence is too weak."""
        scores = self.scores(text)
        if not scores: return "", 0.0
        category, confidence = max(scores.items(), key=lambda item: item[1])
        features = self.features(text)
        supported = any(self.counts[category].get(feature) for feature in features)
        return (category, confidence) if supported and confidence >= min_confidence else ("", confidence)
