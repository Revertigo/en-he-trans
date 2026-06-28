import Foundation

enum AppMode: Equatable {
    case liveMicrophone
    case mock

    static var current: AppMode {
        let arguments = ProcessInfo.processInfo.arguments

        #if targetEnvironment(simulator)
        return .mock
        #else
        return arguments.contains("--mock-mode") ? .mock : .liveMicrophone
        #endif
    }

    var displayName: String {
        switch self {
        case .liveMicrophone:
            return "Live microphone"
        case .mock:
            return "Mock transcript"
        }
    }
}

struct TranscriptSegment: Identifiable, Codable, Equatable {
    let id: UUID
    let createdAt: Date
    var englishText: String
    var hebrewText: String
    var isPartial: Bool
}

struct SpeechRecognitionUpdate: Equatable {
    let englishText: String
    let isFinal: Bool
    let timestamp: Date
}

struct TranslationJob: Equatable {
    let segmentID: UUID
    let englishText: String
    let isFinal: Bool
}

struct TranslationResolution: Equatable {
    let job: TranslationJob
    let hebrewText: String
}

enum ListeningStatus: Equatable {
    case idle
    case preparing
    case listening
    case unavailable(String)
    case failed(String)

    var message: String {
        switch self {
        case .idle:
            return "Ready to listen."
        case .preparing:
            return "Preparing microphone, speech recognition, and translation."
        case .listening:
            return "Listening through the iPhone microphone."
        case .unavailable(let reason), .failed(let reason):
            return reason
        }
    }
}

enum MockTranslationEngine {
    private static let translationMap: [String: String] = [
        "The story opens on a quiet road just before sunrise.":
            "הסיפור נפתח על כביש שקט ממש לפני הזריחה.",
        "You can hear the narrator slow down when the scene becomes tense.":
            "אפשר לשמוע שהמספר מאט כשהסצנה נעשית מתוחה.",
        "Sometimes a single unfamiliar phrase changes the meaning of the whole paragraph.":
            "לפעמים ביטוי אחד לא מוכר משנה את המשמעות של כל הפסקה.",
        "This mock mode lets us verify the English and Hebrew screens before testing on a real phone.":
            "מצב הדמיה זה מאפשר לנו לבדוק את המסכים באנגלית ובעברית לפני בדיקה בטלפון אמיתי."
    ]

    static func translate(_ englishText: String) -> String {
        // Check for exact full-sentence match
        if let hebrew = translationMap[englishText] {
            return hebrew
        }

        // For partial sentences (word-by-word streaming), find the best matching sentence
        for (english, hebrew) in translationMap {
            if english.hasPrefix(englishText) {
                // Show proportional Hebrew text based on how much English we've seen
                let progress = Double(englishText.count) / Double(english.count)
                let hebrewChars = Int(Double(hebrew.count) * progress)
                let partialHebrew = String(hebrew.prefix(max(1, hebrewChars)))
                return partialHebrew
            }
        }

        return englishText
    }
}
