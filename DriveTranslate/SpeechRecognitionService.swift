import AVFoundation
import Foundation
import Speech

struct PermissionSnapshot: Equatable {
    let microphoneGranted: Bool
    let speechStatus: SFSpeechRecognizerAuthorizationStatus

    var isReady: Bool {
        microphoneGranted && speechStatus == .authorized
    }
}

enum SpeechRecognitionServiceError: LocalizedError {
    case recognizerUnavailable
    case couldNotCreateRecognizer
    case duplicateStart

    var errorDescription: String? {
        switch self {
        case .recognizerUnavailable:
            return "Speech recognition is not currently available for English."
        case .couldNotCreateRecognizer:
            return "The app could not create an English speech recognizer."
        case .duplicateStart:
            return "The recognizer is already running."
        }
    }
}

protocol SpeechRecognitionServiceProtocol: AnyObject {
    func requestPermissions() async -> PermissionSnapshot
    func startStreaming(
        localeIdentifier: String,
        onUpdate: @escaping (Result<SpeechRecognitionUpdate, Error>) -> Void
    ) async throws
    func stopStreaming() async
}

@MainActor
final class AppleSpeechRecognitionService: NSObject, SpeechRecognitionServiceProtocol, SFSpeechRecognizerDelegate {
    private let audioEngine = AVAudioEngine()
    private var recognizer: SFSpeechRecognizer?
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var onUpdate: ((Result<SpeechRecognitionUpdate, Error>) -> Void)?
    private(set) var isStreaming = false

    func requestPermissions() async -> PermissionSnapshot {
        let microphoneGranted = await withCheckedContinuation { continuation in
            if #available(iOS 17.0, *) {
                AVAudioApplication.requestRecordPermission { granted in
                    continuation.resume(returning: granted)
                }
            } else {
                AVAudioSession.sharedInstance().requestRecordPermission { granted in
                    continuation.resume(returning: granted)
                }
            }
        }

        let speechStatus = await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { status in
                continuation.resume(returning: status)
            }
        }

        return PermissionSnapshot(
            microphoneGranted: microphoneGranted,
            speechStatus: speechStatus
        )
    }

    func startStreaming(
        localeIdentifier: String = "en-US",
        onUpdate: @escaping (Result<SpeechRecognitionUpdate, Error>) -> Void
    ) async throws {
        guard !isStreaming else {
            throw SpeechRecognitionServiceError.duplicateStart
        }

        self.onUpdate = onUpdate
        let locale = Locale(identifier: localeIdentifier)

        guard let recognizer = SFSpeechRecognizer(locale: locale) else {
            throw SpeechRecognitionServiceError.couldNotCreateRecognizer
        }

        guard recognizer.isAvailable else {
            throw SpeechRecognitionServiceError.recognizerUnavailable
        }

        self.recognizer = recognizer
        self.recognizer?.delegate = self

        try configureAudioSession()
        try startRecognitionPipeline()
        isStreaming = true
    }

    func stopStreaming() async {
        stopRecognitionPipeline(deactivateSession: true)
        onUpdate = nil
        isStreaming = false
    }

    private func configureAudioSession() throws {
        let session = AVAudioSession.sharedInstance()

        try session.setCategory(
            .playAndRecord,
            mode: .measurement,
            options: [.mixWithOthers, .allowBluetooth, .allowBluetoothA2DP]
        )

        if let builtInMic = session.availableInputs?.first(where: { $0.portType == .builtInMic }) {
            try? session.setPreferredInput(builtInMic)
        }

        try session.setActive(true, options: .notifyOthersOnDeactivation)
    }

    private func startRecognitionPipeline() throws {
        recognitionTask?.cancel()
        recognitionTask = nil

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true

        if #available(iOS 13, *) {
            request.requiresOnDeviceRecognition = true
        }

        recognitionRequest = request

        let inputNode = audioEngine.inputNode
        inputNode.removeTap(onBus: 0)
        inputNode.installTap(onBus: 0, bufferSize: 1024, format: inputNode.outputFormat(forBus: 0)) { [weak self] buffer, _ in
            self?.recognitionRequest?.append(buffer)
        }

        audioEngine.prepare()
        try audioEngine.start()

        recognitionTask = recognizer?.recognitionTask(with: request) { [weak self] result, error in
            guard let self else { return }

            if let result {
                self.onUpdate?(
                    .success(
                        SpeechRecognitionUpdate(
                            englishText: result.bestTranscription.formattedString,
                            isFinal: result.isFinal,
                            timestamp: Date()
                        )
                    )
                )

                if result.isFinal {
                    self.stopRecognitionPipeline(deactivateSession: false)
                    self.isStreaming = false
                }
            }

            if let error {
                self.onUpdate?(.failure(error))
                self.stopRecognitionPipeline(deactivateSession: false)
                self.isStreaming = false
            }
        }
    }

    private func stopRecognitionPipeline(deactivateSession: Bool) {
        if audioEngine.isRunning {
            audioEngine.stop()
        }

        audioEngine.inputNode.removeTap(onBus: 0)
        recognitionRequest?.endAudio()
        recognitionTask?.cancel()
        recognitionRequest = nil
        recognitionTask = nil

        if deactivateSession {
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
    }
}
