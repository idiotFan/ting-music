#import "../src-tauri/native/media_controls.m"
static int delivered;
static void receive(const char *json) {
    NSDictionary *value = [NSJSONSerialization JSONObjectWithData:[[NSString stringWithUTF8String:json] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
    NSCAssert([value[@"action"] isEqual:@"nexttrack"], @"Wrong action"); delivered++;
}
int main(void) {
    @autoreleasepool {
        [NSApplication sharedApplication];
        ting_media_init(receive);
        NSUInteger count = targets.count;
        ting_media_init(receive);
        NSCAssert(targets.count == count && count == 7, @"Duplicate handlers");
        NSCAssert(ting_media_update("{\"track\":{\"title\":\"Ting test\",\"artist\":\"artist\",\"album\":\"album\"},\"playbackState\":\"playing\",\"position\":{\"duration\":100,\"position\":12,\"playbackRate\":1}}") == 1, @"Update failed");
        MPRemoteCommandCenter *c = MPRemoteCommandCenter.sharedCommandCenter;
        NSCAssert(c.nextTrackCommand.enabled && c.previousTrackCommand.enabled && c.changePlaybackPositionCommand.enabled, @"Missing transport commands");
        NSCAssert(!c.skipForwardCommand.enabled && !c.skipBackwardCommand.enabled, @"Competing skip buttons");
        NSCAssert([MPNowPlayingInfoCenter.defaultCenter.nowPlayingInfo[MPMediaItemPropertyTitle] isEqual:@"Ting test"], @"Metadata mismatch");
        Action(@"nexttrack", nil, 0);
        NSCAssert(delivered == 1, @"Callback not delivered");
        ting_media_update("{\"track\":null,\"playbackState\":\"none\",\"position\":null}");
        NSCAssert(!c.nextTrackCommand.enabled && MPNowPlayingInfoCenter.defaultCenter.nowPlayingInfo == nil, @"Stale media remains");
        Action(@"nexttrack", nil, 0);
        NSCAssert(delivered == 1, @"Inactive action dispatched");
        ting_media_shutdown();
        puts("Native Apple media controls passed");
    }
}
