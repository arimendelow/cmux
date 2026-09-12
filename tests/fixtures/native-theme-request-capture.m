#import <Foundation/Foundation.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/stat.h>
#include <unistd.h>

static int captureDirectory = -1;

static _Noreturn void captureFailure(const char *message) {
    fprintf(stderr, "native theme capture: %s\n", message);
    _exit(78);
}

static void recordCapture(NSString *name, NSDictionary *record) {
    NSError *error = nil;
    NSData *data = [NSJSONSerialization dataWithJSONObject:record options:NSJSONWritingSortedKeys error:&error];
    if (data == nil) captureFailure("cannot encode receipt");
    int fd = openat(captureDirectory, name.fileSystemRepresentation, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (fd < 0) captureFailure("cannot exclusively create receipt");
    const uint8_t *bytes = data.bytes;
    NSUInteger remaining = data.length;
    while (remaining > 0) {
        ssize_t count = write(fd, bytes, remaining);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) captureFailure("cannot complete receipt");
        bytes += count;
        remaining -= count;
    }
    if (close(fd) != 0) captureFailure("cannot close receipt");
}

@interface CMUXNativeThemeRequestCapture : NSURLProtocol
@end

@implementation CMUXNativeThemeRequestCapture

// A required native link puts this before app startup, not in the later-loaded test bundle.
+ (void)load {
    @autoreleasepool {
        const char *path = getenv("CMUX_TEST_THEME_CAPTURE_DIRECTORY");
        if (path == NULL || path[0] != '/') captureFailure("requires an absolute capture directory");
        captureDirectory = open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        struct stat info;
        if (captureDirectory < 0 || fstat(captureDirectory, &info) != 0 ||
            !S_ISDIR(info.st_mode) || info.st_uid != geteuid() || (info.st_mode & 0777) != 0700) {
            captureFailure("requires an owned mode0700 capture directory");
        }
        if (![NSURLProtocol registerClass:self]) captureFailure("protocol registration failed");
        NSMutableDictionary *environment = [NSMutableDictionary dictionary];
        for (NSString *key in @[@"HOME", @"CFFIXED_USER_HOME", @"TMPDIR", @"ZDOTDIR"]) {
            const char *value = getenv(key.UTF8String);
            environment[key] = value == NULL ? NSNull.null : [NSString stringWithUTF8String:value];
        }
        recordCapture(@"bootstrap.json", @{
            @"pid": @(getpid()),
            @"environment": environment,
            @"cwd": NSFileManager.defaultManager.currentDirectoryPath,
            @"bundleIdentifier": NSBundle.mainBundle.bundleIdentifier ?: NSNull.null,
        });
    }
}

+ (BOOL)canInitWithRequest:(NSURLRequest *)request {
    NSString *scheme = request.URL.scheme.lowercaseString;
    return ([scheme isEqualToString:@"http"] || [scheme isEqualToString:@"https"]) &&
        [request.URL.path hasSuffix:@"/api/theme"];
}

+ (NSURLRequest *)canonicalRequestForRequest:(NSURLRequest *)request {
    return request;
}

- (void)startLoading {
    NSMutableData *body = self.request.HTTPBody.mutableCopy ?: [NSMutableData data];
    if (self.request.HTTPBody == nil && self.request.HTTPBodyStream != nil) {
        NSInputStream *stream = self.request.HTTPBodyStream;
        [stream open];
        uint8_t buffer[4096];
        NSInteger count;
        while ((count = [stream read:buffer maxLength:sizeof(buffer)]) > 0) {
            if (body.length + count > 1024 * 1024) captureFailure("request body exceeds fixture limit");
            [body appendBytes:buffer length:count];
        }
        if (count < 0) captureFailure("cannot read request body");
        [stream close];
    }
    if (body.length > 1024 * 1024) captureFailure("request body exceeds fixture limit");
    NSString *requestID = NSUUID.UUID.UUIDString;
    recordCapture([requestID stringByAppendingString:@".request.json"], @{
        @"requestId": requestID,
        @"method": self.request.HTTPMethod ?: @"",
        @"url": self.request.URL.absoluteString,
        @"contentType": [self.request valueForHTTPHeaderField:@"Content-Type"] ?: @"",
        @"body": [body base64EncodedStringWithOptions:0],
    });
    NSData *reply = [@"{\"captured\":true}" dataUsingEncoding:NSUTF8StringEncoding];
    NSHTTPURLResponse *response = [[NSHTTPURLResponse alloc]
        initWithURL:self.request.URL
        statusCode:200
        HTTPVersion:@"HTTP/1.1"
        headerFields:@{@"Content-Type": @"application/json", @"Content-Length": @(reply.length).stringValue}];
    if (response == nil) captureFailure("cannot construct capture response");
    [self.client URLProtocol:self didReceiveResponse:response cacheStoragePolicy:NSURLCacheStorageNotAllowed];
    [self.client URLProtocol:self didLoadData:reply];
    // Completion can let a CLI exit immediately; seal the prepared response first.
    recordCapture([requestID stringByAppendingString:@".complete.json"], @{
        @"requestId": requestID,
        @"phase": @"response-completion-prepared",
        @"status": @200,
    });
    [self.client URLProtocolDidFinishLoading:self];
}

- (void)stopLoading {}

@end
