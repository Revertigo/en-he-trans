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
    static func translate(_ englishText: String) -> String {
        let tokens = englishText
            .split(separator: " ")
            .map(String.init)

        guard !tokens.isEmpty else { return "" }

        let transformed = tokens.map { token in
            switch token.lowercased() {
            case "the":
                return "ha"
            case "and":
                return "ve"
            case "you":
                return "ata"
            case "book":
                return "sefer"
            case "story":
                return "sipur"
            default:
                return token
            }
        }

        return "[Mock HE] " + transformed.joined(separator: " ")
    }
}
