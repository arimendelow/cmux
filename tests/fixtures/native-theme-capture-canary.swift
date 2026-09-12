import Foundation

guard CommandLine.arguments.count == 3,
      let url = URL(string: CommandLine.arguments[1]) else {
    throw URLError(.badURL)
}
let environment = ProcessInfo.processInfo.environment
let captureDirectory = environment["CMUX_TEST_THEME_CAPTURE_DIRECTORY"]
let marker: [String: Any] = [
    "pid": ProcessInfo.processInfo.processIdentifier,
    "captureReadyAtMain": captureDirectory.map {
        FileManager.default.fileExists(atPath: $0 + "/bootstrap.json")
    } ?? false,
]
try JSONSerialization.data(withJSONObject: marker, options: [.sortedKeys])
    .write(to: URL(fileURLWithPath: CommandLine.arguments[2]), options: .withoutOverwriting)
var request = URLRequest(url: url, timeoutInterval: 3)
request.httpMethod = "POST"
request.setValue("application/json", forHTTPHeaderField: "Content-Type")
request.httpBody = Data(##"{"source":"native-canary","background":"#121218"}"##.utf8)
let (body, response) = try await URLSession.shared.data(for: request)
guard let response = response as? HTTPURLResponse else {
    throw URLError(.badServerResponse)
}
let result: [String: Any] = ["status": response.statusCode, "body": body.base64EncodedString()]
FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]))
