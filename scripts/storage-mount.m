// macOS-only storage provisioner. Secrets arrive on stdin, never argv/environment/logs.
// Build: clang -framework Foundation -framework Security -framework NetFS -o <local helper> this.m
#import <Foundation/Foundation.h>
#import <Security/Security.h>
#import <NetFS/NetFS.h>
#include <sys/mount.h>
#include <termios.h>
#include <unistd.h>

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc < 4) { fprintf(stderr, "Usage: storage-mount save|check SERVICE ACCOUNT; mount SERVICE ACCOUNT URL MOUNTPOINT\n"); return 64; }
    NSString *op = @(argv[1]), *service = @(argv[2]), *account = @(argv[3]);
    NSMutableDictionary *query = [@{(__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
      (__bridge id)kSecAttrService: service, (__bridge id)kSecAttrAccount: account} mutableCopy];
    SecKeychainSetUserInteractionAllowed(false); // unattended recovery must never open a login dialog
    if ([op isEqualToString:@"save"]) {
      struct termios original, hidden; BOOL terminal = isatty(STDIN_FILENO) && tcgetattr(STDIN_FILENO, &original) == 0;
      if (terminal) { hidden = original; hidden.c_lflag &= ~ECHO; tcsetattr(STDIN_FILENO, TCSAFLUSH, &hidden); }
      char *line = NULL; size_t capacity = 0; ssize_t length = getline(&line, &capacity, stdin);
      if (terminal) tcsetattr(STDIN_FILENO, TCSAFLUSH, &original);
      if (length < 1) { free(line); fprintf(stderr, "No credential received\n"); return 65; }
      while (length && (line[length - 1] == '\n' || line[length - 1] == '\r')) length--;
      NSData *secret = [NSData dataWithBytes:line length:length]; memset(line, 0, capacity); free(line);
      if (!secret.length) return 65;
      NSDictionary *attributes = @{(__bridge id)kSecValueData: secret};
      OSStatus status = SecItemUpdate((__bridge CFDictionaryRef)query, (__bridge CFDictionaryRef)attributes);
      if (status == errSecItemNotFound) {
        [query addEntriesFromDictionary:attributes];
        query[(__bridge id)kSecAttrLabel] = @"AIOS Spark storage (unattended mount)";
        status = SecItemAdd((__bridge CFDictionaryRef)query, NULL);
      }
      if (status) { fprintf(stderr, "Keychain save failed (%d)\n", (int)status); return 1; }
      puts("Credential saved in macOS Keychain; value not displayed."); return 0;
    }
    query[(__bridge id)kSecReturnData] = @YES;
    CFTypeRef result = NULL;
    OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)query, &result);
    if (status) { fprintf(stderr, "Keychain credential unavailable (%d)\n", (int)status); return 1; }
    NSData *secret = CFBridgingRelease(result);
    if ([op isEqualToString:@"check"]) { puts("Keychain credential available without interaction."); return 0; }
    if (![op isEqualToString:@"mount"] || argc != 6) return 64;
    NSURL *url = [NSURL URLWithString:@(argv[4])];
    if (![url.scheme isEqualToString:@"smb"] || url.password.length) return 64;
    NSString *password = [[NSString alloc] initWithData:secret encoding:NSUTF8StringEncoding];
    NSMutableDictionary *openOptions = [@{(__bridge id)kNAUIOptionKey: (__bridge id)kNAUIOptionNoUI,
      (__bridge id)kNetFSForceNewSessionKey: @YES} mutableCopy];
    NSMutableDictionary *mountOptions = [@{(__bridge id)kNetFSMountAtMountDirKey: @YES,
      (__bridge id)kNetFSMountFlagsKey: @(MNT_DONTBROWSE | MNT_NOSUID | MNT_NODEV)} mutableCopy];
    CFArrayRef mounted = NULL;
    int error = NetFSMountURLSync((__bridge CFURLRef)url,
      (__bridge CFURLRef)[NSURL fileURLWithPath:@(argv[5]) isDirectory:YES],
      (__bridge CFStringRef)account, (__bridge CFStringRef)password,
      (__bridge CFMutableDictionaryRef)openOptions, (__bridge CFMutableDictionaryRef)mountOptions, &mounted);
    if (mounted) CFRelease(mounted);
    if (error) { fprintf(stderr, "Storage mount failed (%d)\n", error); return 1; }
    puts("Storage mounted using Keychain credential.");
    return 0;
  }
}
