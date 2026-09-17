#import <Foundation/Foundation.h>
#import <TargetConditionals.h>
#if TARGET_OS_IPHONE
#import <UIKit/UIKit.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>
#else
#import <AppKit/AppKit.h>
#endif
// C boundary returns owned UTF-8 JSON. No paths, bookmarks, or native errors are logged.
typedef void (*TingCallback)(const char *, void *);
static char *JSON(id value) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:value options:0 error:nil];
    return strdup([[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding].UTF8String ?: "{}");
}
static NSDictionary *Failure(NSString *message) { return @{ @"error":message }; }
static NSDictionary *Bookmark(NSURL *url) {
    BOOL accessed = [url startAccessingSecurityScopedResource];
    NSError *error = nil;
#if TARGET_OS_IPHONE
    NSURLBookmarkCreationOptions options = 0;
#else
    NSURLBookmarkCreationOptions options = NSURLBookmarkCreationWithSecurityScope;
#endif
    NSData *data = [url bookmarkDataWithOptions:options includingResourceValuesForKeys:nil relativeToURL:nil error:&error];
    NSNumber *cloud = nil;
    [url getResourceValue:&cloud forKey:NSURLIsUbiquitousItemKey error:nil];
    if (accessed) [url stopAccessingSecurityScopedResource];
    return data ? @{ @"bookmark":[data base64EncodedStringWithOptions:0], @"folder":url.lastPathComponent ?: @"Ting", @"icloud":@(cloud.boolValue) } : Failure(@"无法保存文件夹授权，请重新选择");
}
#if TARGET_OS_IPHONE
@interface TingFolderDelegate : NSObject <UIDocumentPickerDelegate>
@property(nonatomic,assign) TingCallback callback;
@property(nonatomic,assign) void *context;
@end
static TingFolderDelegate *activePicker;
@implementation TingFolderDelegate
- (void)finish:(NSDictionary *)result {
    TingCallback fn = self.callback;
    void *context = self.context;
    self.callback = NULL;
    if (fn) { char *json = JSON(result); fn(json, context); free(json); }
    activePicker = nil;
}
- (void)documentPicker:(UIDocumentPickerViewController *)controller didPickDocumentsAtURLs:(NSArray<NSURL *> *)urls {
    [self finish:urls.count ? Bookmark(urls.firstObject) : @{ @"cancelled":@YES }];
}
- (void)documentPickerWasCancelled:(UIDocumentPickerViewController *)controller { [self finish:@{ @"cancelled":@YES }]; }
@end
#endif
void ting_sync_choose(void *controller, TingCallback callback, void *context) {
    @autoreleasepool {
#if TARGET_OS_IPHONE
        UIViewController *host = (__bridge UIViewController *)controller;
        if (!host || host.presentedViewController || activePicker) {
            char *json=JSON(Failure(@"请先关闭当前系统面板")); callback(json,context); free(json); return;
        }
        activePicker = [TingFolderDelegate new];
        activePicker.callback = callback; activePicker.context = context;
        UIDocumentPickerViewController *picker = [[UIDocumentPickerViewController alloc] initForOpeningContentTypes:@[UTTypeFolder] asCopy:NO];
        picker.allowsMultipleSelection = NO;
        picker.delegate = activePicker;
        [host presentViewController:picker animated:YES completion:nil];
#else
        (void)controller;
        NSOpenPanel *panel = [NSOpenPanel openPanel];
        panel.canChooseDirectories=YES; panel.canChooseFiles=NO; panel.allowsMultipleSelection=NO; panel.canCreateDirectories=YES;
        panel.message=@"在 iCloud 云盘中选择或新建 Ting 文件夹；iPhone 上也选择同一个文件夹。";
        panel.prompt=@"使用此文件夹";
        [panel beginWithCompletionHandler:^(NSModalResponse response) {
            char *json = JSON(response == NSModalResponseOK ? Bookmark(panel.URL) : @{ @"cancelled":@YES });
            callback(json,context); free(json);
        }];
#endif
    }
}
// Resolve the saved grant on each operation. Coordinate with iCloud/File Provider,
// use one independently-owned snapshot per device, and replace files atomically.
char *ting_sync_exchange(const char *bookmark, const char *filename, const char *payload) {
    @autoreleasepool {
        NSData *grant = [[NSData alloc] initWithBase64EncodedString:@(bookmark) options:0];
        if (!grant.length || grant.length>65536) return JSON(Failure(@"文件夹授权无效，请重新选择"));
        BOOL stale=NO;
#if TARGET_OS_IPHONE
        NSURLBookmarkResolutionOptions options=NSURLBookmarkResolutionWithoutUI;
#else
        NSURLBookmarkResolutionOptions options=NSURLBookmarkResolutionWithSecurityScope | NSURLBookmarkResolutionWithoutUI;
#endif
        NSURL *root = [NSURL URLByResolvingBookmarkData:grant options:options relativeToURL:nil bookmarkDataIsStale:&stale error:nil];
        if (!root) return JSON(Failure(@"文件夹授权已失效，请重新选择 iCloud 文件夹"));
        BOOL access = [root startAccessingSecurityScopedResource];
        if (!access) return JSON(Failure(@"无法访问同步文件夹，请重新授权"));
        @try {
            NSURL *folder = [root URLByAppendingPathComponent:@"Ting-Sync-v1" isDirectory:YES];
            NSFileManager *fm = NSFileManager.defaultManager;
            NSFileCoordinator *coordinator = [[NSFileCoordinator alloc] initWithFilePresenter:nil];
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 20*NSEC_PER_SEC), dispatch_get_global_queue(QOS_CLASS_UTILITY,0), ^{ [coordinator cancel]; });
            __block NSString *problem = nil;
            NSError *error = nil;
            [coordinator coordinateWritingItemAtURL:folder options:0 error:&error byAccessor:^(NSURL *url) {
                NSNumber *link=nil; [url getResourceValue:&link forKey:NSURLIsSymbolicLinkKey error:nil];
                BOOL directory=NO; BOOL exists=[fm fileExistsAtPath:url.path isDirectory:&directory];
                if (link.boolValue || (exists ? !directory : ![fm createDirectoryAtURL:url withIntermediateDirectories:NO attributes:nil error:nil])) problem=@"无法准备同步目录，请检查 iCloud 空间和文件夹权限";
            }];
            if (error || problem) return JSON(Failure(problem ?: @"iCloud 文件夹暂不可用"));
            // Reads happen before writes; a corrupt or not-yet-downloaded peer must
            // not be mistaken for an empty library. Rust validates every document.
            __block NSMutableArray *documents = [NSMutableArray array];
            __block BOOL pending=NO;
            __block NSUInteger totalBytes=0;
            NSArray<NSURL *> *files = [fm contentsOfDirectoryAtURL:folder includingPropertiesForKeys:@[NSURLIsRegularFileKey, NSURLIsSymbolicLinkKey, NSURLFileSizeKey] options:0 error:&error];
            if (!files || files.count > 128) return JSON(Failure(@"同步目录不可读或文件数量过多"));
            for (NSURL *file in files) {
                NSString *name=file.lastPathComponent;
                if ([name hasPrefix:@".device-"] && name.length>8 && [name hasSuffix:@".icloud"]) { [fm startDownloadingUbiquitousItemAtURL:[folder URLByAppendingPathComponent:[name substringWithRange:NSMakeRange(1,name.length-8)]] error:nil]; pending=YES; continue; }
                if (![name hasPrefix:@"device-"] || ![name hasSuffix:@".json"]) continue;
                NSNumber *link=nil, *regular=nil, *size=nil;
                [file getResourceValue:&link forKey:NSURLIsSymbolicLinkKey error:nil];
                [file getResourceValue:&regular forKey:NSURLIsRegularFileKey error:nil];
                [file getResourceValue:&size forKey:NSURLFileSizeKey error:nil];
                if (link.boolValue || !regular.boolValue || size.unsignedLongLongValue > 16*1024*1024) return JSON(Failure(@"同步文件异常，已保留本机数据"));
                NSString *download=nil; [file getResourceValue:&download forKey:NSURLUbiquitousItemDownloadingStatusKey error:nil];
                if (download && ![download isEqualToString:NSURLUbiquitousItemDownloadingStatusCurrent]) { [fm startDownloadingUbiquitousItemAtURL:file error:nil]; pending=YES; continue; }
                [coordinator coordinateReadingItemAtURL:file options:0 error:&error byAccessor:^(NSURL *url) {
                    NSData *bytes=[NSData dataWithContentsOfURL:url options:NSDataReadingMappedIfSafe error:nil];
                    totalBytes += bytes.length;
                    NSString *text=bytes.length <= 16*1024*1024 && totalBytes <= 32*1024*1024 ? [[NSString alloc] initWithData:bytes encoding:NSUTF8StringEncoding] : nil;
                    if (!text) problem=@"同步文件尚不可读，请稍后重试";
                    else [documents addObject:text];
                }];
                if (error || problem) return JSON(Failure(problem ?: @"读取 iCloud 歌单失败"));
            }
            if (payload && strlen(payload) > 0) {
                NSString *name=@(filename);
                if (![name hasPrefix:@"device-"] || ![name hasSuffix:@".json"] || [name containsString:@"/"] || [name containsString:@".."])
                    return JSON(Failure(@"同步文件名无效"));
                NSURL *file=[folder URLByAppendingPathComponent:name];
                [coordinator coordinateWritingItemAtURL:file options:NSFileCoordinatorWritingForReplacing error:&error byAccessor:^(NSURL *url) {
                    NSNumber *link=nil; [url getResourceValue:&link forKey:NSURLIsSymbolicLinkKey error:nil];
                    NSData *bytes=[@(payload) dataUsingEncoding:NSUTF8StringEncoding];
                    NSData *old=[NSData dataWithContentsOfURL:url options:NSDataReadingMappedIfSafe error:nil];
                    if (link.boolValue || bytes.length > 16*1024*1024 || (![bytes isEqualToData:old] && ![bytes writeToURL:url options:NSDataWritingAtomic error:nil])) problem=@"写入 iCloud 歌单失败，本机修改已保留";
                }];
                if (error || problem) return JSON(Failure(problem ?: @"iCloud 暂时无法写入"));
            }
            NSMutableDictionary *result=[@{ @"documents":documents, @"pending":@(pending) } mutableCopy];
            if (stale) { NSDictionary *renewed=Bookmark(root); if (renewed[@"bookmark"]) result[@"bookmark"]=renewed[@"bookmark"]; }
            return JSON(result);
        } @finally { [root stopAccessingSecurityScopedResource]; }
    }
}
void ting_sync_free(char *value) { free(value); }
