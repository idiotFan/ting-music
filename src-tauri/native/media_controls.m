#import <Foundation/Foundation.h>
#import <MediaPlayer/MediaPlayer.h>
#import <AVFoundation/AVFoundation.h>
#import <TargetConditionals.h>
#if TARGET_OS_IPHONE
#import <UIKit/UIKit.h>
#else
#import <AppKit/AppKit.h>
#endif
#include <math.h>

typedef void (*TingMediaCallback)(const char *);
static TingMediaCallback emitAction;
static NSMutableArray *targets;
static BOOL active;
#if TARGET_OS_IPHONE
static BOOL audioSessionActive;
#endif
static NSString *coverData;
static MPMediaItemArtwork *artwork;
static NSMutableDictionary *information;
static void Action(NSString *action, NSString *key, double value) {
    if (!active || !emitAction) return;
    NSMutableDictionary *event = [@{@"action":action} mutableCopy];
    if (key && isfinite(value)) event[key] = @(value);
    NSData *json = [NSJSONSerialization dataWithJSONObject:event options:0 error:nil];
    emitAction([[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding].UTF8String);
}
static void Register(MPRemoteCommand *command, NSString *action) {
    id target = [command addTargetWithHandler:^MPRemoteCommandHandlerStatus(MPRemoteCommandEvent *event) {
        (void)event;
        if (!active) return MPRemoteCommandHandlerStatusNoSuchContent;
        Action(action, nil, 0);
        return MPRemoteCommandHandlerStatusSuccess;
    }];
    [targets addObject:@[command, target]];
}
void ting_media_init(TingMediaCallback callback) {
    NSCAssert(NSThread.isMainThread, @"Media controls require main thread");
    emitAction = callback;
    if (targets) return;
    targets = [NSMutableArray array];
    MPRemoteCommandCenter *center = MPRemoteCommandCenter.sharedCommandCenter;
    Register(center.playCommand, @"play");
    Register(center.pauseCommand, @"pause");
    Register(center.togglePlayPauseCommand, @"toggle");
    Register(center.stopCommand, @"stop");
    Register(center.previousTrackCommand, @"previoustrack");
    Register(center.nextTrackCommand, @"nexttrack");
    id target = [center.changePlaybackPositionCommand addTargetWithHandler:^MPRemoteCommandHandlerStatus(MPRemoteCommandEvent *event) {
        if (!active) return MPRemoteCommandHandlerStatusNoSuchContent;
        double seconds = ((MPChangePlaybackPositionCommandEvent *)event).positionTime;
        if (!isfinite(seconds) || seconds < 0) return MPRemoteCommandHandlerStatusCommandFailed;
        Action(@"seekto", @"seekTime", seconds);
        return MPRemoteCommandHandlerStatusSuccess;
    }];
    [targets addObject:@[center.changePlaybackPositionCommand, target]];
#if TARGET_OS_IPHONE
    [UIApplication.sharedApplication beginReceivingRemoteControlEvents];
#endif
}
// Called on the main thread with validated data. No network, private API, or
// polling: artwork is the same bounded PNG already decoded by the player.
int ting_media_update(const char *json) {
    NSCAssert(NSThread.isMainThread, @"Media controls require main thread");
    NSData *data = [[NSString stringWithUTF8String:json] dataUsingEncoding:NSUTF8StringEncoding];
    NSDictionary *state = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
    if (![state isKindOfClass:NSDictionary.class]) return 0;
    NSDictionary *track = state[@"track"];
    active = [track isKindOfClass:NSDictionary.class];
    MPRemoteCommandCenter *commands = MPRemoteCommandCenter.sharedCommandCenter;
    for (MPRemoteCommand *command in @[commands.playCommand, commands.pauseCommand,
         commands.togglePlayPauseCommand, commands.stopCommand,
         commands.previousTrackCommand, commands.nextTrackCommand]) command.enabled = active;
    commands.skipBackwardCommand.enabled = NO;
    commands.skipForwardCommand.enabled = NO;
    commands.seekBackwardCommand.enabled = NO;
    commands.seekForwardCommand.enabled = NO;
    NSDictionary *position = state[@"position"];
    BOOL seekable = [position isKindOfClass:NSDictionary.class] && [position[@"duration"] doubleValue] > 0;
    commands.changePlaybackPositionCommand.enabled = active && seekable;
    MPNowPlayingInfoCenter *center = MPNowPlayingInfoCenter.defaultCenter;
    if (!active) {
        information = nil; artwork = nil; coverData = nil;
        center.nowPlayingInfo = nil;
#if !TARGET_OS_IPHONE
        center.playbackState = MPNowPlayingPlaybackStateStopped;
#endif
        return 1;
    }
    BOOL playing = [state[@"playbackState"] isEqual:@"playing"];
#if TARGET_OS_IPHONE
    if (playing && !audioSessionActive) {
        AVAudioSession *session = AVAudioSession.sharedInstance;
        NSError *error = nil;
        if (![session setCategory:AVAudioSessionCategoryPlayback mode:AVAudioSessionModeDefault options:0 error:&error] ||
            ![session setActive:YES error:&error]) return 0;
        audioSessionActive = YES;
    }
#endif
    information = [@{MPMediaItemPropertyTitle:track[@"title"] ?: @"",
                     MPMediaItemPropertyArtist:track[@"artist"] ?: @"",
                     MPMediaItemPropertyAlbumTitle:track[@"album"] ?: @"",
                     MPNowPlayingInfoPropertyMediaType:@(MPNowPlayingInfoMediaTypeAudio),
                     MPNowPlayingInfoPropertyIsLiveStream:@NO,
                     MPNowPlayingInfoPropertyPlaybackRate:playing ? @1 : @0} mutableCopy];
    NSString *encoded = track[@"artwork"];
    if (![encoded isKindOfClass:NSString.class]) encoded = @"";
    if (![coverData isEqual:encoded]) {
        coverData = encoded; artwork = nil;
        NSString *prefix = @"data:image/png;base64,";
        if ([encoded hasPrefix:prefix]) {
            NSData *png = [[NSData alloc] initWithBase64EncodedString:[encoded substringFromIndex:prefix.length] options:0];
#if TARGET_OS_IPHONE
            UIImage *image = [UIImage imageWithData:png];
#else
            NSImage *image = [[NSImage alloc] initWithData:png];
#endif
            if (image) artwork = [[MPMediaItemArtwork alloc] initWithBoundsSize:image.size requestHandler:^id(CGSize size) { (void)size; return image; }];
        }
    }
    if (artwork) information[MPMediaItemPropertyArtwork] = artwork;
    if (seekable) {
        information[MPMediaItemPropertyPlaybackDuration] = position[@"duration"];
        information[MPNowPlayingInfoPropertyElapsedPlaybackTime] = position[@"position"];
        information[MPNowPlayingInfoPropertyPlaybackRate] = playing ? position[@"playbackRate"] : @0;
    }
    center.nowPlayingInfo = information;
#if !TARGET_OS_IPHONE
    center.playbackState = playing ? MPNowPlayingPlaybackStatePlaying : MPNowPlayingPlaybackStatePaused;
#endif
    return 1;
}
void ting_media_shutdown(void) {
    for (NSArray *entry in targets) [entry[0] removeTarget:entry[1]];
    targets = nil; active = NO; emitAction = NULL;
    MPNowPlayingInfoCenter.defaultCenter.nowPlayingInfo = nil;
#if TARGET_OS_IPHONE
    [UIApplication.sharedApplication endReceivingRemoteControlEvents];
#endif
}
