#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <signal.h>

/** The transparent strip keeps the native, edge-to-edge titlebar draggable. */
@interface OpenWriterDragRegion : NSView
@end

@implementation OpenWriterDragRegion
- (void)mouseDown:(NSEvent *)event { [self.window performWindowDragWithEvent:event]; }
@end

@interface OpenWriterAppDelegate : NSObject <NSApplicationDelegate, WKNavigationDelegate, WKScriptMessageHandler>
@property(nonatomic, strong) NSWindow *window;
@property(nonatomic, strong) WKWebView *webView;
@property(nonatomic, strong) OpenWriterDragRegion *dragRegion;
@property(nonatomic) NSInteger servicePort;
@property(nonatomic) BOOL retriedNavigation;
@property(nonatomic, copy) NSString *serviceBuildId;
@end

@implementation OpenWriterAppDelegate

- (NSMenuItem *)menuItemWithTitle:(NSString *)title action:(SEL)action keyEquivalent:(NSString *)keyEquivalent modifierMask:(NSEventModifierFlags)modifierMask {
    NSMenuItem *item = [[NSMenuItem alloc] initWithTitle:title action:action keyEquivalent:keyEquivalent];
    item.target = nil; // Send editing commands through WKWebView's responder chain.
    item.keyEquivalentModifierMask = modifierMask;
    return item;
}

- (void)installMainMenu {
    NSMenu *menuBar = [[NSMenu alloc] initWithTitle:@""];
    NSMenuItem *appItem = [[NSMenuItem alloc] initWithTitle:@"OpenWriter" action:nil keyEquivalent:@""];
    NSMenu *appMenu = [[NSMenu alloc] initWithTitle:@"OpenWriter"];
    [appMenu addItem:[self menuItemWithTitle:@"About OpenWriter" action:@selector(orderFrontStandardAboutPanel:) keyEquivalent:@"" modifierMask:NSEventModifierFlagCommand]];
    [appMenu addItem:[NSMenuItem separatorItem]];
    [appMenu addItem:[self menuItemWithTitle:@"Hide OpenWriter" action:@selector(hide:) keyEquivalent:@"h" modifierMask:NSEventModifierFlagCommand]];
    [appMenu addItem:[self menuItemWithTitle:@"Hide Others" action:@selector(hideOtherApplications:) keyEquivalent:@"h" modifierMask:(NSEventModifierFlagCommand | NSEventModifierFlagOption)]];
    [appMenu addItem:[self menuItemWithTitle:@"Show All" action:@selector(unhideAllApplications:) keyEquivalent:@"" modifierMask:NSEventModifierFlagCommand]];
    [appMenu addItem:[NSMenuItem separatorItem]];
    [appMenu addItem:[self menuItemWithTitle:@"Quit OpenWriter" action:@selector(terminate:) keyEquivalent:@"q" modifierMask:NSEventModifierFlagCommand]];
    appItem.submenu = appMenu;
    [menuBar addItem:appItem];

    NSMenuItem *fileItem = [[NSMenuItem alloc] initWithTitle:@"File" action:nil keyEquivalent:@""];
    NSMenu *fileMenu = [[NSMenu alloc] initWithTitle:@"File"];
    [fileMenu addItem:[self menuItemWithTitle:@"Close Window" action:@selector(performClose:) keyEquivalent:@"w" modifierMask:NSEventModifierFlagCommand]];
    fileItem.submenu = fileMenu;
    [menuBar addItem:fileItem];

    NSMenuItem *editItem = [[NSMenuItem alloc] initWithTitle:@"Edit" action:nil keyEquivalent:@""];
    NSMenu *editMenu = [[NSMenu alloc] initWithTitle:@"Edit"];
    [editMenu addItem:[self menuItemWithTitle:@"Undo" action:@selector(undo:) keyEquivalent:@"z" modifierMask:NSEventModifierFlagCommand]];
    [editMenu addItem:[self menuItemWithTitle:@"Redo" action:@selector(redo:) keyEquivalent:@"z" modifierMask:(NSEventModifierFlagCommand | NSEventModifierFlagShift)]];
    [editMenu addItem:[NSMenuItem separatorItem]];
    [editMenu addItem:[self menuItemWithTitle:@"Cut" action:@selector(cut:) keyEquivalent:@"x" modifierMask:NSEventModifierFlagCommand]];
    [editMenu addItem:[self menuItemWithTitle:@"Copy" action:@selector(copy:) keyEquivalent:@"c" modifierMask:NSEventModifierFlagCommand]];
    [editMenu addItem:[self menuItemWithTitle:@"Paste" action:@selector(paste:) keyEquivalent:@"v" modifierMask:NSEventModifierFlagCommand]];
    [editMenu addItem:[self menuItemWithTitle:@"Paste and Match Style" action:@selector(pasteAsPlainText:) keyEquivalent:@"v" modifierMask:(NSEventModifierFlagCommand | NSEventModifierFlagOption | NSEventModifierFlagShift)]];
    [editMenu addItem:[NSMenuItem separatorItem]];
    [editMenu addItem:[self menuItemWithTitle:@"Select All" action:@selector(selectAll:) keyEquivalent:@"a" modifierMask:NSEventModifierFlagCommand]];
    editItem.submenu = editMenu;
    [menuBar addItem:editItem];

    NSMenuItem *viewItem = [[NSMenuItem alloc] initWithTitle:@"View" action:nil keyEquivalent:@""];
    NSMenu *viewMenu = [[NSMenu alloc] initWithTitle:@"View"];
    [viewMenu addItem:[self menuItemWithTitle:@"Enter Full Screen" action:@selector(toggleFullScreen:) keyEquivalent:@"f" modifierMask:(NSEventModifierFlagCommand | NSEventModifierFlagControl)]];
    viewItem.submenu = viewMenu;
    [menuBar addItem:viewItem];

    NSMenuItem *windowItem = [[NSMenuItem alloc] initWithTitle:@"Window" action:nil keyEquivalent:@""];
    NSMenu *windowMenu = [[NSMenu alloc] initWithTitle:@"Window"];
    [windowMenu addItem:[self menuItemWithTitle:@"Minimize" action:@selector(performMiniaturize:) keyEquivalent:@"m" modifierMask:NSEventModifierFlagCommand]];
    [windowMenu addItem:[self menuItemWithTitle:@"Zoom" action:@selector(performZoom:) keyEquivalent:@"" modifierMask:NSEventModifierFlagCommand]];
    [windowMenu addItem:[NSMenuItem separatorItem]];
    [windowMenu addItem:[self menuItemWithTitle:@"Bring All to Front" action:@selector(arrangeInFront:) keyEquivalent:@"" modifierMask:NSEventModifierFlagCommand]];
    windowItem.submenu = windowMenu;
    [menuBar addItem:windowItem];
    [NSApp setMainMenu:menuBar];
}

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    [self installMainMenu];
    NSString *portValue = NSProcessInfo.processInfo.environment[@"OPENWRITER_PORT"];
    if (!portValue.length) portValue = [NSBundle.mainBundle objectForInfoDictionaryKey:@"OpenWriterPort"];
    NSInteger requestedPort = portValue.integerValue;
    self.servicePort = requestedPort >= 1 && requestedPort <= 65535 ? requestedPort : 5050;
    self.serviceBuildId = [self bundledServiceBuildId];

    self.window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 1180, 820)
                                              styleMask:(NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable | NSWindowStyleMaskFullSizeContentView)
                                                backing:NSBackingStoreBuffered defer:NO];
    self.window.title = @"";
    self.window.titleVisibility = NSWindowTitleHidden;
    self.window.titlebarAppearsTransparent = YES;
    self.window.collectionBehavior = NSWindowCollectionBehaviorFullScreenPrimary;
    if (@available(macOS 11.0, *)) self.window.titlebarSeparatorStyle = NSTitlebarSeparatorStyleNone;
    self.window.minSize = NSMakeSize(850, 600);
    [self.window setFrameAutosaveName:@"OpenWriterWindow"];
    [[NSNotificationCenter defaultCenter] addObserver:self selector:@selector(windowDidEnterFullScreen:) name:NSWindowDidEnterFullScreenNotification object:self.window];
    [[NSNotificationCenter defaultCenter] addObserver:self selector:@selector(windowDidExitFullScreen:) name:NSWindowDidExitFullScreenNotification object:self.window];

    WKWebViewConfiguration *configuration = [[WKWebViewConfiguration alloc] init];
    [configuration.userContentController addScriptMessageHandler:self name:@"openwriterDebug"];
    [configuration.userContentController addScriptMessageHandler:self name:@"openwriterNative"];
    // macOS 11 ships a WebKit version from before Object.hasOwn(). The
    // compiled client uses that modern convenience method, so define the
    // standards-equivalent fallback before any application script runs. This
    // affects only the embedded native window; modern browsers keep their
    // built-in implementation.
    NSString *compatibilityScript = @"(function(){if(typeof Object.hasOwn!=='function'){Object.hasOwn=function(object,property){return Object.prototype.hasOwnProperty.call(object,property);};}if(typeof crypto!=='undefined'&&typeof crypto.randomUUID!=='function'&&typeof crypto.getRandomValues==='function'){crypto.randomUUID=function(){var bytes=new Uint8Array(16);crypto.getRandomValues(bytes);bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;var hex=[];for(var index=0;index<bytes.length;index+=1){hex.push((bytes[index]+256).toString(16).slice(1));}return hex.slice(0,4).join('')+'-'+hex.slice(4,6).join('')+'-'+hex.slice(6,8).join('')+'-'+hex.slice(8,10).join('')+'-'+hex.slice(10,16).join('');};}if(!Array.prototype.at){Object.defineProperty(Array.prototype,'at',{value:function(index){var length=this.length>>>0;var relative=Number(index)||0;var actual=relative>=0?relative:length+relative;return actual<0||actual>=length?undefined:this[actual];},configurable:true,writable:true});}if(!Array.prototype.findLast){Object.defineProperty(Array.prototype,'findLast',{value:function(predicate,thisArg){var value=Object(this);for(var index=value.length-1;index>=0;index-=1){if(index in value&&predicate.call(thisArg,value[index],index,value))return value[index];}return undefined;},configurable:true,writable:true});}if(!Array.prototype.findLastIndex){Object.defineProperty(Array.prototype,'findLastIndex',{value:function(predicate,thisArg){var value=Object(this);for(var index=value.length-1;index>=0;index-=1){if(index in value&&predicate.call(thisArg,value[index],index,value))return index;}return -1;},configurable:true,writable:true});}})();";
    [configuration.userContentController addUserScript:[[WKUserScript alloc] initWithSource:compatibilityScript injectionTime:WKUserScriptInjectionTimeAtDocumentStart forMainFrameOnly:YES]];
    NSString *debugScript = @"window.addEventListener('error',function(event){var detail=event.message||('Failed to load: '+((event.target&&event.target.src)||'unknown resource'));var location=event.filename?(' @ '+event.filename+':'+event.lineno+':'+event.colno):'';var stack=event.error&&event.error.stack?('\\n'+event.error.stack):'';window.webkit.messageHandlers.openwriterDebug.postMessage('Browser error: '+detail+location+stack);},true);window.addEventListener('unhandledrejection',function(event){var reason=event.reason;var stack=reason&&reason.stack?('\\n'+reason.stack):'';window.webkit.messageHandlers.openwriterDebug.postMessage('Unhandled promise: '+String(reason)+stack);});";
    [configuration.userContentController addUserScript:[[WKUserScript alloc] initWithSource:debugScript injectionTime:WKUserScriptInjectionTimeAtDocumentStart forMainFrameOnly:YES]];
    NSString *nativeWindowScript = @"(function(){var addStyle=function(){if(document.getElementById('openwriter-native-window-style'))return;var style=document.createElement('style');style.id='openwriter-native-window-style';style.textContent='html,body{background:var(--bg-titlebar,#f8f8f8)!important}.sidebar-topbar{padding-left:76px!important}html.openwriter-native-fullscreen .sidebar-topbar{padding-left:12px!important}.openwriter-native-sidebar-menu{display:none}.sidebar-topbar.openwriter-native-hide-wordmark .sidebar-logo-text{display:none!important}.sidebar-topbar.openwriter-native-actions-overflow{position:relative!important}.sidebar-topbar.openwriter-native-actions-overflow .sidebar-topbar-actions{position:absolute!important;top:calc(100% - 1px);right:8px;display:none!important;gap:2px!important;padding:4px!important;background:var(--bg-surface)!important;border:1px solid var(--border)!important;border-radius:8px!important;box-shadow:0 3px 8px #0000001f!important;z-index:100!important}.sidebar-topbar.openwriter-native-actions-overflow.openwriter-native-actions-open .sidebar-topbar-actions{display:flex!important}.sidebar-topbar.openwriter-native-actions-overflow .openwriter-native-sidebar-menu{display:flex!important;align-items:center!important;justify-content:center!important;width:30px!important;height:30px!important;padding:0!important;border:none!important;background:none!important;border-radius:6px!important;color:var(--ink-light)!important;cursor:pointer!important}.openwriter-native-sidebar-menu:hover,.openwriter-native-sidebar-menu:focus-visible{background:var(--bg-hover)!important;color:var(--ink-dark)!important;outline:none!important}';(document.head||document.documentElement).appendChild(style);};var installMenu=function(){var bar=document.querySelector('.sidebar-topbar'),sidebar=bar&&bar.closest('.sidebar');if(!bar||!sidebar||bar.querySelector('.openwriter-native-sidebar-menu'))return!!bar;var button=document.createElement('button');button.type='button';button.className='openwriter-native-sidebar-menu';button.title='Sidebar controls';button.setAttribute('aria-label','Sidebar controls');button.setAttribute('aria-expanded','false');button.innerHTML=\"<svg width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2.4' stroke-linecap='round'><circle cx='5' cy='12' r='1'/><circle cx='12' cy='12' r='1'/><circle cx='19' cy='12' r='1'/></svg>\";var update=function(){var full=document.documentElement.classList.contains('openwriter-native-fullscreen'),width=sidebar.getBoundingClientRect().width,hideWordmark=width<(full?268:300),overflow=width<(full?166:230);bar.classList.toggle('openwriter-native-hide-wordmark',hideWordmark);bar.classList.toggle('openwriter-native-actions-overflow',overflow);if(!overflow){bar.classList.remove('openwriter-native-actions-open');button.setAttribute('aria-expanded','false');}};window.openwriterNativeUpdateSidebarHeader=update;new ResizeObserver(update).observe(sidebar);new MutationObserver(update).observe(document.documentElement,{attributes:true,attributeFilter:['class']});button.addEventListener('click',function(event){event.stopPropagation();var open=bar.classList.toggle('openwriter-native-actions-open');button.setAttribute('aria-expanded',String(open));});document.addEventListener('click',function(event){if(!bar.contains(event.target)){bar.classList.remove('openwriter-native-actions-open');button.setAttribute('aria-expanded','false');}});bar.appendChild(button);update();return true;};var boot=function(){addStyle();if(!installMenu()){var tries=0,retry=setInterval(function(){tries+=1;if(installMenu()||tries===40)clearInterval(retry);},100);}};if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',boot,{once:true});}else{boot();}})();";
    [configuration.userContentController addUserScript:[[WKUserScript alloc] initWithSource:nativeWindowScript injectionTime:WKUserScriptInjectionTimeAtDocumentStart forMainFrameOnly:YES]];
    // Open hosted services in the person's normal browser. This is especially
    // important for GitHub's device sign-in, which should not happen inside a
    // local writing window. Relative/local export URLs retain WebKit's normal
    // behavior because only absolute HTTP(S) links are intercepted.
    NSString *externalLinkScript = @"(function(){var originalOpen=window.open;window.open=function(url){var value=typeof url==='string'?url:'';if(/^https?:\\/\\//i.test(value)&&window.webkit&&window.webkit.messageHandlers&&window.webkit.messageHandlers.openwriterNative){try{window.webkit.messageHandlers.openwriterNative.postMessage({type:'openExternal',url:value});return null;}catch(error){}}return originalOpen.apply(window,arguments);};})();";
    [configuration.userContentController addUserScript:[[WKUserScript alloc] initWithSource:externalLinkScript injectionTime:WKUserScriptInjectionTimeAtDocumentStart forMainFrameOnly:YES]];

    self.webView = [[WKWebView alloc] initWithFrame:self.window.contentView.bounds configuration:configuration];
    self.webView.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    self.webView.navigationDelegate = self;
    [self.window.contentView addSubview:self.webView];
    NSRect bounds = self.window.contentView.bounds;
    self.dragRegion = [[OpenWriterDragRegion alloc] initWithFrame:NSMakeRect(76, bounds.size.height - 12, MAX(0, bounds.size.width - 76), 12)];
    self.dragRegion.autoresizingMask = NSViewWidthSizable | NSViewMinYMargin;
    [self.window.contentView addSubview:self.dragRegion positioned:NSWindowAbove relativeTo:self.webView];

    [self.window makeKeyAndOrderFront:nil];
    [NSApp activateIgnoringOtherApps:YES];
    [self showLaunchState];
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{ [self startServiceAndLoadWriter]; });
}

- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)sender { return YES; }

- (NSURL *)serviceURL {
    return [NSURL URLWithString:[NSString stringWithFormat:@"http://127.0.0.1:%ld/", (long)self.servicePort]];
}

- (NSString *)bundledServiceBuildId {
    NSString *entrypoint = [NSBundle.mainBundle.resourcePath stringByAppendingPathComponent:@"openwriter/dist/bin/pad.js"];
    NSDictionary<NSFileAttributeKey, id> *attributes = [[NSFileManager defaultManager] attributesOfItemAtPath:entrypoint error:nil];
    NSDate *modified = attributes[NSFileModificationDate];
    NSNumber *size = attributes[NSFileSize];
    if (!modified || !size) return @"";
    return [NSString stringWithFormat:@"%.0f-%@", modified.timeIntervalSince1970 * 1000, size];
}

- (NSDictionary *)serviceStatus {
    NSString *url = [NSString stringWithFormat:@"http://127.0.0.1:%ld/api/status", (long)self.servicePort];
    NSTask *task = [[NSTask alloc] init];
    NSPipe *output = [NSPipe pipe];
    task.executableURL = [NSURL fileURLWithPath:@"/usr/bin/curl"];
    task.arguments = @[@"-fsS", @"--max-time", @"1", url];
    task.standardOutput = output;
    task.standardError = [NSFileHandle fileHandleWithNullDevice];
    @try {
        [task launch];
        [task waitUntilExit];
        if (task.terminationStatus != 0) return nil;
        NSData *data = [[output fileHandleForReading] readDataToEndOfFile];
        id value = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
        return [value isKindOfClass:[NSDictionary class]] ? value : nil;
    }
    @catch (NSException *exception) { return nil; }
}

- (BOOL)isServiceHealthy {
    NSDictionary *status = [self serviceStatus];
    if (!status) return NO;
    // Source/developer launches have no bundle marker. A bundled native app
    // must require its own marker, otherwise reopening it after an update can
    // silently attach to an obsolete no-longer-compatible service.
    if (!self.serviceBuildId.length) return YES;
    NSString *runningBuildId = [status[@"serviceBuildId"] isKindOfClass:[NSString class]] ? status[@"serviceBuildId"] : nil;
    return [runningBuildId isEqualToString:self.serviceBuildId];
}

- (NSString *)commandForProcessId:(pid_t)pid {
    NSTask *task = [[NSTask alloc] init];
    NSPipe *output = [NSPipe pipe];
    task.executableURL = [NSURL fileURLWithPath:@"/bin/ps"];
    task.arguments = @[@"-p", [NSString stringWithFormat:@"%d", pid], @"-o", @"command="];
    task.standardOutput = output;
    task.standardError = [NSFileHandle fileHandleWithNullDevice];
    @try {
        [task launch];
        [task waitUntilExit];
        if (task.terminationStatus != 0) return @"";
        NSData *data = [[output fileHandleForReading] readDataToEndOfFile];
        return [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] ?: @"";
    }
    @catch (NSException *exception) { return @""; }
}

- (void)stopStaleServiceForCurrentBundleIfSafe {
    // Only terminate a service that was launched by this exact app bundle.
    // A different app (or a developer server) using the port is left alone;
    // the native app then reports that it could not start instead of taking
    // over another person's active writing service.
    NSTask *task = [[NSTask alloc] init];
    NSPipe *output = [NSPipe pipe];
    task.executableURL = [NSURL fileURLWithPath:@"/usr/sbin/lsof"];
    // Build the selector as a single literal argument, so no shell
    // interpolation is involved.
    task.arguments = @[[NSString stringWithFormat:@"-tiTCP:%ld", (long)self.servicePort], @"-sTCP:LISTEN"];
    task.standardOutput = output;
    task.standardError = [NSFileHandle fileHandleWithNullDevice];
    @try { [task launch]; [task waitUntilExit]; }
    @catch (NSException *exception) { return; }
    NSData *data = [[output fileHandleForReading] readDataToEndOfFile];
    NSString *pids = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] ?: @"";
    NSString *bundlePath = NSBundle.mainBundle.bundlePath;
    BOOL stoppedService = NO;
    for (NSString *line in [pids componentsSeparatedByCharactersInSet:NSCharacterSet.newlineCharacterSet]) {
        pid_t pid = (pid_t)line.integerValue;
        if (pid <= 0) continue;
        NSString *command = [self commandForProcessId:pid];
        if ([command containsString:bundlePath] && [command containsString:@"/Contents/Resources/openwriter/dist/bin/pad.js"]) {
            if (kill(pid, SIGTERM) == 0) stoppedService = YES;
        }
    }
    // Avoid racing a new Node service against the just-terminated listener.
    // This is bounded and runs only after stopping a stale service owned by
    // this exact bundle.
    if (stoppedService) {
        for (NSInteger attempt = 0; attempt < 20; attempt++) {
            if (![self serviceStatus]) break;
            usleep(100000);
        }
    }
}

- (NSString *)bundledServiceInvocation {
    NSString *resources = NSBundle.mainBundle.resourcePath;
    NSString *node = [resources stringByAppendingPathComponent:@"runtime/node"];
    NSString *entrypoint = [resources stringByAppendingPathComponent:@"openwriter/dist/bin/pad.js"];
    if (![[NSFileManager defaultManager] isExecutableFileAtPath:node] || ![[NSFileManager defaultManager] fileExistsAtPath:entrypoint]) return nil;
    return [NSString stringWithFormat:@"%@ %@", [self shellQuote:node], [self shellQuote:entrypoint]];
}

- (void)installBundledBootstrapAtRoot:(NSString *)root {
    NSString *bootstrap = [NSBundle.mainBundle.resourcePath stringByAppendingPathComponent:@"bootstrap"];
    NSFileManager *files = NSFileManager.defaultManager;
    BOOL isDirectory = NO;
    if (![files fileExistsAtPath:bootstrap isDirectory:&isDirectory] || !isDirectory) return;

    NSError *error = nil;
    [files createDirectoryAtPath:root withIntermediateDirectories:YES attributes:nil error:&error];
    if (error) return;

    // A personalized author bundle may carry a first-run profile and a
    // credentials-free config. They are copied only when absent, so later app
    // updates never replace writing or preferences on the author's machine.
    NSString *sourceConfig = [bootstrap stringByAppendingPathComponent:@"config.json"];
    NSString *destinationConfig = [root stringByAppendingPathComponent:@"config.json"];
    if ([files fileExistsAtPath:sourceConfig] && ![files fileExistsAtPath:destinationConfig]) {
        [files copyItemAtPath:sourceConfig toPath:destinationConfig error:nil];
    }

    NSString *sourceProfiles = [bootstrap stringByAppendingPathComponent:@"profiles"];
    if (![files fileExistsAtPath:sourceProfiles isDirectory:&isDirectory] || !isDirectory) return;
    NSString *destinationProfiles = [root stringByAppendingPathComponent:@"profiles"];
    [files createDirectoryAtPath:destinationProfiles withIntermediateDirectories:YES attributes:nil error:nil];
    for (NSString *name in [files contentsOfDirectoryAtPath:sourceProfiles error:nil] ?: @[]) {
        NSString *source = [sourceProfiles stringByAppendingPathComponent:name];
        NSString *destination = [destinationProfiles stringByAppendingPathComponent:name];
        if (![files fileExistsAtPath:destination]) [files copyItemAtPath:source toPath:destination error:nil];
    }
}

- (void)startServiceIfNeeded {
    if ([self isServiceHealthy]) return;
    [self stopStaleServiceForCurrentBundleIfSafe];
    NSDictionary *environment = NSProcessInfo.processInfo.environment;
    // A packaged app carries its own Node runtime and compiled OpenWriter
    // bundle. The source-build fallback remains useful to contributors, but
    // no longer assumes a specific developer's NVM version.
    NSString *command = environment[@"OPENWRITER_COMMAND"];
    NSString *bundledInvocation = [self bundledServiceInvocation];
    NSString *serviceInvocation = command.length
        ? command
        : (bundledInvocation.length ? bundledInvocation : @"node \"$(npm root -g)/openwriter/dist/bin/pad.js\"");
    NSString *root = environment[@"OPENWRITER_ROOT_DIR"];
    if (!root.length) root = [NSBundle.mainBundle objectForInfoDictionaryKey:@"OpenWriterRootDir"];
    if (!root.length && bundledInvocation.length) {
        root = [NSHomeDirectory() stringByAppendingPathComponent:@"Library/Application Support/OpenWriter"];
    }
    if (root.length && bundledInvocation.length) [self installBundledBootstrapAtRoot:root];
    NSString *rootPrefix = root.length ? [NSString stringWithFormat:@"export OPENWRITER_ROOT_DIR=%@; ", [self shellQuote:root]] : @"";
    // A GitHub OAuth client ID is public, so a personalized bundle may carry
    // it in Info.plist. The short-lived device code and returned access token
    // never enter this file: OpenWriter keeps them in memory and Keychain.
    NSString *oauthClientId = environment[@"OPENWRITER_GITHUB_OAUTH_CLIENT_ID"];
    if (!oauthClientId.length) oauthClientId = [NSBundle.mainBundle objectForInfoDictionaryKey:@"OpenWriterGitHubOAuthClientID"];
    NSString *oauthPrefix = oauthClientId.length ? [NSString stringWithFormat:@"export OPENWRITER_GITHUB_OAUTH_CLIENT_ID=%@; ", [self shellQuote:oauthClientId]] : @"";
    NSString *buildPrefix = self.serviceBuildId.length ? [NSString stringWithFormat:@"export OPENWRITER_SERVICE_BUILD_ID=%@; ", [self shellQuote:self.serviceBuildId]] : @"";
    NSString *script = [NSString stringWithFormat:@"export PATH=\"/opt/homebrew/bin:/usr/local/bin:$PATH\"; if [ -s \"$HOME/.nvm/nvm.sh\" ]; then . \"$HOME/.nvm/nvm.sh\" >/dev/null 2>&1; fi; %@%@%@ /bin/mkdir -p \"$HOME/Library/Logs\"; nohup %@ --no-open --port %ld </dev/null >\"$HOME/Library/Logs/OpenWriter-launcher.log\" 2>&1 &", oauthPrefix, rootPrefix, buildPrefix, serviceInvocation, (long)self.servicePort];
    NSTask *task = [[NSTask alloc] init];
    task.executableURL = [NSURL fileURLWithPath:@"/bin/zsh"];
    task.arguments = @[@"-lc", script];
    task.standardOutput = [NSFileHandle fileHandleWithNullDevice];
    task.standardError = [NSFileHandle fileHandleWithNullDevice];
    @try { [task launch]; [task waitUntilExit]; } @catch (NSException *exception) { }
}

- (NSString *)shellQuote:(NSString *)value {
    return [NSString stringWithFormat:@"'%@'", [value stringByReplacingOccurrencesOfString:@"'" withString:@"'\\\"'\\\"'"]];
}

- (void)startServiceAndLoadWriter {
    [self startServiceIfNeeded];
    // The app is navigated only after the server's status route responds. A
    // cold boot therefore shows a useful loading view instead of a blank page.
    for (NSInteger attempt = 0; attempt < 75; attempt++) {
        if ([self isServiceHealthy]) {
            dispatch_async(dispatch_get_main_queue(), ^{ [self loadWriter]; });
            return;
        }
        usleep(200000);
    }
    dispatch_async(dispatch_get_main_queue(), ^{ [self showStartupErrorWithMessage:@"The local OpenWriter service did not become ready. Reopen the app after checking ~/Library/Logs/OpenWriter-launcher.log."]; });
}

- (void)loadWriter {
    self.retriedNavigation = NO;
    NSString *url = [NSString stringWithFormat:@"%@?native-launch=%.0f", self.serviceURL.absoluteString, NSDate.date.timeIntervalSince1970 * 1000];
    NSURLRequest *request = [NSURLRequest requestWithURL:[NSURL URLWithString:url] cachePolicy:NSURLRequestReloadIgnoringLocalCacheData timeoutInterval:20];
    [self.webView loadRequest:request];
}

- (void)retryLoadOnce {
    if (self.retriedNavigation) { [self showStartupErrorWithMessage:@"OpenWriter could not load its local editor. Reopen the app after checking ~/Library/Logs/OpenWriter-launcher.log."]; return; }
    self.retriedNavigation = YES;
    [self showLaunchState];
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(700 * NSEC_PER_MSEC)), dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{ [self startServiceAndLoadWriter]; });
}

- (void)showLaunchState {
    NSString *html = @"<html><body style='margin:0;min-height:100vh;display:grid;place-items:center;background:#f7f7f8;color:#1b1b20;font-family:-apple-system,BlinkMacSystemFont,sans-serif'><main style='width:min(360px,calc(100vw - 48px));text-align:center'><div style='font-size:52px;line-height:1;margin-bottom:20px'>✎</div><h1 style='font-size:22px;margin:0 0 8px;font-weight:650'>Opening OpenWriter</h1><p style='font-size:15px;line-height:1.5;margin:0;color:#5d5d67'>Preparing your local writing space.</p></main></body></html>";
    [self.webView loadHTMLString:html baseURL:nil];
}

- (void)showStartupErrorWithMessage:(NSString *)message {
    NSString *html = [NSString stringWithFormat:@"<html><body style='font-family:-apple-system;padding:48px;color:#222'><h2>OpenWriter could not start.</h2><p>%@</p><p style='color:#666'>Technical details: ~/Library/Logs/OpenWriter-launcher.log</p></body></html>", message];
    [self.webView loadHTMLString:html baseURL:nil];
}

- (void)applyNativeFullScreenLayout {
    BOOL fullScreen = (self.window.styleMask & NSWindowStyleMaskFullScreen) != 0;
    [self.webView evaluateJavaScript:[NSString stringWithFormat:@"document.documentElement.classList.toggle('openwriter-native-fullscreen', %@);", fullScreen ? @"true" : @"false"] completionHandler:nil];
}

- (void)windowDidEnterFullScreen:(NSNotification *)notification { [self applyNativeFullScreenLayout]; }
- (void)windowDidExitFullScreen:(NSNotification *)notification { [self applyNativeFullScreenLayout]; }
- (void)webView:(WKWebView *)webView didFinishNavigation:(WKNavigation *)navigation { [self applyNativeFullScreenLayout]; }
- (void)webView:(WKWebView *)webView didFailProvisionalNavigation:(WKNavigation *)navigation withError:(NSError *)error { [self retryLoadOnce]; }
- (void)webView:(WKWebView *)webView didFailNavigation:(WKNavigation *)navigation withError:(NSError *)error { [self retryLoadOnce]; }
- (void)webViewWebContentProcessDidTerminate:(WKWebView *)webView { [self retryLoadOnce]; }

- (void)userContentController:(WKUserContentController *)controller didReceiveScriptMessage:(WKScriptMessage *)message {
    if ([message.name isEqualToString:@"openwriterNative"]) {
        NSString *host = message.frameInfo.securityOrigin.host ?: @"";
        if (!([host isEqualToString:@"127.0.0.1"] || [host isEqualToString:@"localhost"]) || ![message.body isKindOfClass:[NSDictionary class]]) return;
        NSDictionary *payload = (NSDictionary *)message.body;
        NSString *type = [payload[@"type"] isKindOfClass:[NSString class]] ? payload[@"type"] : nil;
        if ([type isEqualToString:@"editorCommand"]) {
            NSString *command = [payload[@"command"] isKindOfClass:[NSString class]] ? payload[@"command"] : nil;
            SEL action = NULL;
            if ([command isEqualToString:@"cut"]) action = @selector(cut:);
            else if ([command isEqualToString:@"copy"]) action = @selector(copy:);
            else if ([command isEqualToString:@"paste"]) action = @selector(paste:);
            else if ([command isEqualToString:@"pastePlain"]) action = @selector(pasteAsPlainText:);
            else if ([command isEqualToString:@"selectAll"]) action = @selector(selectAll:);
            if (action) [NSApp sendAction:action to:nil from:self.webView];
        } else if ([type isEqualToString:@"revealInFinder"]) {
            NSString *path = [payload[@"path"] isKindOfClass:[NSString class]] ? payload[@"path"] : nil;
            NSString *expanded = [path stringByExpandingTildeInPath];
            if (expanded.length && expanded.isAbsolutePath && [[NSFileManager defaultManager] fileExistsAtPath:expanded]) [[NSWorkspace sharedWorkspace] activateFileViewerSelectingURLs:@[[NSURL fileURLWithPath:expanded]]];
        } else if ([type isEqualToString:@"openExternal"]) {
            NSString *urlString = [payload[@"url"] isKindOfClass:[NSString class]] ? payload[@"url"] : nil;
            NSURL *url = [NSURL URLWithString:urlString];
            NSString *scheme = url.scheme.lowercaseString;
            if (url.host.length && ([scheme isEqualToString:@"https"] || [scheme isEqualToString:@"http"])) [[NSWorkspace sharedWorkspace] openURL:url];
        }
        return;
    }

    // Browser diagnostics are valuable, but must never replace the document
    // with an error page. A recoverable script error is not a launcher failure.
    NSString *logPath = [NSHomeDirectory() stringByAppendingPathComponent:@"Library/Logs/OpenWriter-webview.log"];
    [[message.body description] writeToFile:logPath atomically:YES encoding:NSUTF8StringEncoding error:nil];
}

@end

int main(int argc, const char * argv[]) {
    @autoreleasepool {
        NSApplication *application = [NSApplication sharedApplication];
        [application setActivationPolicy:NSApplicationActivationPolicyRegular];
        // NSApplication's delegate is non-owning. Keep it alive for the full
        // process lifetime so a cold launch cannot lose its service controller.
        static OpenWriterAppDelegate *delegate;
        delegate = [[OpenWriterAppDelegate alloc] init];
        application.delegate = delegate;
        [application run];
    }
    return 0;
}
