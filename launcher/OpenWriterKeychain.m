#import <Foundation/Foundation.h>
#import <Security/Security.h>

/**
 * Read and store opaque credential data in the macOS login Keychain without
 * placing the secret in a process argument. The Node service passes only the
 * public action/service/account values as argv; writes receive JSON on stdin
 * and reads return it only on stdout to that local Node process.
 */
int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc != 4) {
            fputs("Usage: OpenWriterKeychain <read|write|delete> <service> <account>\n", stderr);
            return 64;
        }

        NSString *action = [[NSString alloc] initWithUTF8String:argv[1]];
        NSString *service = [[NSString alloc] initWithUTF8String:argv[2]];
        NSString *account = [[NSString alloc] initWithUTF8String:argv[3]];
        NSData *serviceData = [service dataUsingEncoding:NSUTF8StringEncoding];
        NSData *accountData = [account dataUsingEncoding:NSUTF8StringEncoding];
        if (!serviceData.length || !accountData.length) {
            fputs("OpenWriter Keychain received incomplete key identity.\n", stderr);
            return 65;
        }

        SecKeychainItemRef existing = NULL;
        OSStatus status = SecKeychainFindGenericPassword(
            NULL,
            (UInt32)serviceData.length, serviceData.bytes,
            (UInt32)accountData.length, accountData.bytes,
            NULL, NULL, &existing
        );
        if ([action isEqualToString:@"read"]) {
            UInt32 credentialLength = 0;
            void *credentialBytes = NULL;
            if (existing) {
                CFRelease(existing);
                existing = NULL;
            }
            status = SecKeychainFindGenericPassword(
                NULL,
                (UInt32)serviceData.length, serviceData.bytes,
                (UInt32)accountData.length, accountData.bytes,
                &credentialLength, &credentialBytes, NULL
            );
            if (status == errSecSuccess) {
                NSData *credentialData = [NSData dataWithBytes:credentialBytes length:credentialLength];
                [[NSFileHandle fileHandleWithStandardOutput] writeData:credentialData];
                SecKeychainItemFreeContent(NULL, credentialBytes);
                return 0;
            }
        } else if ([action isEqualToString:@"delete"]) {
            if (status == errSecSuccess) {
                status = SecKeychainItemDelete(existing);
                CFRelease(existing);
            }
        } else if ([action isEqualToString:@"write"]) {
            NSData *credentialData = [[NSFileHandle fileHandleWithStandardInput] readDataToEndOfFile];
            if (!credentialData.length) {
                if (existing) CFRelease(existing);
                fputs("OpenWriter Keychain received incomplete credential data.\n", stderr);
                return 65;
            }
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
        } else {
            if (existing) CFRelease(existing);
            fputs("OpenWriter Keychain received an unsupported action.\n", stderr);
            return 64;
        }

        if (status != errSecSuccess && !(status == errSecItemNotFound && [action isEqualToString:@"delete"])) {
            fprintf(stderr, "OpenWriter Keychain could not complete the request (%d).\n", (int)status);
            return 1;
        }
        return 0;
    }
}
