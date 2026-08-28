#import <Foundation/Foundation.h>
#import <Security/Security.h>

/**
 * Store opaque credential data in the macOS login Keychain without placing the
 * secret in a process argument. The Node service passes only the public
 * service/account names as argv; the JSON credential arrives over stdin.
 */
int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc != 3) {
            fputs("Usage: OpenWriterKeychain <service> <account>\n", stderr);
            return 64;
        }

        NSString *service = [[NSString alloc] initWithUTF8String:argv[1]];
        NSString *account = [[NSString alloc] initWithUTF8String:argv[2]];
        NSData *serviceData = [service dataUsingEncoding:NSUTF8StringEncoding];
        NSData *accountData = [account dataUsingEncoding:NSUTF8StringEncoding];
        NSData *credentialData = [[NSFileHandle fileHandleWithStandardInput] readDataToEndOfFile];
        if (!serviceData.length || !accountData.length || !credentialData.length) {
            fputs("OpenWriter Keychain received incomplete credential data.\n", stderr);
            return 65;
        }

        SecKeychainItemRef existing = NULL;
        OSStatus status = SecKeychainFindGenericPassword(
            NULL,
            (UInt32)serviceData.length, serviceData.bytes,
            (UInt32)accountData.length, accountData.bytes,
            NULL, NULL, &existing
        );
        if (status == errSecSuccess) {
            status = SecKeychainItemModifyAttributesAndData(
                existing,
                NULL,
                (UInt32)credentialData.length,
                credentialData.bytes
            );
            CFRelease(existing);
        } else if (status == errSecItemNotFound) {
            status = SecKeychainAddGenericPassword(
                NULL,
                (UInt32)serviceData.length, serviceData.bytes,
                (UInt32)accountData.length, accountData.bytes,
                (UInt32)credentialData.length, credentialData.bytes,
                NULL
            );
        }

        if (status != errSecSuccess) {
            fprintf(stderr, "OpenWriter Keychain could not save the credential (%d).\n", (int)status);
            return 1;
        }
        return 0;
    }
}
