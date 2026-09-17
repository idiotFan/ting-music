// macOS smoke test of the actual bookmark / file-coordination bridge.
#import "../src-tauri/native/folder_sync.m"
static NSDictionary *Exchange(NSString *bookmark, NSString *body) {
    char *json=ting_sync_exchange(bookmark.UTF8String,"device-00000000-0000-4000-8000-000000000001.json",body.UTF8String);
    NSData *bytes=[NSData dataWithBytes:json length:strlen(json)]; ting_sync_free(json);
    return [NSJSONSerialization JSONObjectWithData:bytes options:0 error:nil];
}
int main(void) { @autoreleasepool {
    NSURL *root=[NSURL fileURLWithPath:[NSTemporaryDirectory() stringByAppendingPathComponent:[@"ting-sync-" stringByAppendingString:NSUUID.UUID.UUIDString]] isDirectory:YES];
    NSFileManager *fm=NSFileManager.defaultManager;
    NSCAssert([fm createDirectoryAtURL:root withIntermediateDirectories:NO attributes:nil error:nil],@"temp directory");
    NSDictionary *grant=Bookmark(root);
    NSCAssert(grant[@"bookmark"],@"bookmark creation");
    NSDictionary *first=Exchange(grant[@"bookmark"],@"{\"version\":1,\"clock\":0,\"lists\":{}}");
    NSCAssert(!first[@"error"],@"first exchange failed: %@",first[@"error"]);
    NSURL *folder=[root URLByAppendingPathComponent:@"Ting-Sync-v1"];
    NSURL *file=[folder URLByAppendingPathComponent:@"device-00000000-0000-4000-8000-000000000001.json"];
    NSDate *before=nil; [file getResourceValue:&before forKey:NSURLContentModificationDateKey error:nil];
    NSDictionary *second=Exchange(grant[@"bookmark"],@"{\"version\":1,\"clock\":0,\"lists\":{}}");
    NSCAssert([second[@"documents"] count]==1,@"snapshot readback: %@",second);
    [file removeAllCachedResourceValues]; NSDate *after=nil; [file getResourceValue:&after forKey:NSURLContentModificationDateKey error:nil];
    NSCAssert([before isEqualToDate:after],@"unchanged snapshot must not upload again");
    NSCAssert(Exchange(@"invalid",@"")[@"error"],@"invalid bookmark rejected");
    NSURL *link=[folder URLByAppendingPathComponent:@"device-peer.json"];
    NSCAssert([fm createSymbolicLinkAtURL:link withDestinationURL:file error:nil],@"symlink fixture");
    NSCAssert(Exchange(grant[@"bookmark"],@"")[@"error"],@"symlinks rejected");
    [fm removeItemAtURL:root error:nil];
    puts("Native bookmark, atomic file exchange, unchanged-write suppression and invalid-grant/symlink checks passed.");
} return 0; }
