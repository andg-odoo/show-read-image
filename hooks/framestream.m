// framestream <video> <boxW> <boxH> <fps> <start>
// Plays a video in real time from <start> seconds, fitted inside boxW×boxH pixels, at most <fps> frames a second.
// stdout: META {json}, then "FRAME <t> <base64 png>" per frame, then END.
#import <AVFoundation/AVFoundation.h>
#import <CoreMedia/CoreMedia.h>
#import <ImageIO/ImageIO.h>
#import <VideoToolbox/VideoToolbox.h>
#include <time.h>
#include <unistd.h>

static double now(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec + ts.tv_nsec / 1e9;
}

static void out(NSString *line) {
    NSData *data = [[line stringByAppendingString:@"\n"] dataUsingEncoding:NSUTF8StringEncoding];
    fwrite(data.bytes, 1, data.length, stdout);
    fflush(stdout);
}

int main(int argc, const char **argv) {
    @autoreleasepool {
        if (argc < 6) {
            fprintf(stderr, "usage: framestream <video> <boxW> <boxH> <fps> <start>\n");
            return 2;
        }
        signal(SIGPIPE, SIG_DFL);
        NSURL *url = [NSURL fileURLWithPath:[NSString stringWithUTF8String:argv[1]]];
        double boxW = atof(argv[2]), boxH = atof(argv[3]), fps = atof(argv[4]), start = atof(argv[5]);
        if (fps <= 0) fps = 30;

        AVURLAsset *asset = [AVURLAsset URLAssetWithURL:url options:nil];
        __block AVAssetTrack *track = nil;
        dispatch_semaphore_t sem = dispatch_semaphore_create(0);
        [asset loadTracksWithMediaType:AVMediaTypeVideo completionHandler:^(NSArray<AVAssetTrack *> *tracks, NSError *error) {
            track = tracks.firstObject;
            dispatch_semaphore_signal(sem);
        }];
        dispatch_semaphore_wait(sem, DISPATCH_TIME_FOREVER);
        if (!track) { fprintf(stderr, "no video track\n"); return 1; }
        double duration = CMTimeGetSeconds(asset.duration);
        CGSize natural = track.naturalSize;
        double scale = fmin(boxW / natural.width, boxH / natural.height);
        if (scale > 1) scale = 1;
        int w = (int)fmax(1, floor(natural.width * scale)), h = (int)fmax(1, floor(natural.height * scale));
        if (w > 2048) { h = h * 2048 / w; w = 2048; }
        if (h > 2048) { w = w * 2048 / h; h = 2048; }

        NSError *error = nil;
        AVAssetReader *reader = [AVAssetReader assetReaderWithAsset:asset error:&error];
        if (!reader) { fprintf(stderr, "%s\n", error.description.UTF8String); return 1; }
        reader.timeRange = CMTimeRangeMake(CMTimeMakeWithSeconds(start, 600), kCMTimePositiveInfinity);
        AVAssetReaderTrackOutput *output = [AVAssetReaderTrackOutput assetReaderTrackOutputWithTrack:track outputSettings:@{
            (id)kCVPixelBufferPixelFormatTypeKey: @(kCVPixelFormatType_32BGRA),
        }];
        output.alwaysCopiesSampleData = NO;
        [reader addOutput:output];
        [reader startReading];

        out([NSString stringWithFormat:@"META {\"duration\":%.3f,\"width\":%d,\"height\":%d,\"source\":[%d,%d]}", duration, w, h,
                                       (int)natural.width, (int)natural.height]);

        CGColorSpaceRef space = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
        CGContextRef ctx = CGBitmapContextCreate(NULL, w, h, 8, (size_t)w * 4, space, (CGBitmapInfo)kCGImageAlphaPremultipliedLast);
        double wallStart = 0, firstPts = -1, nextDue = -1;
        int sent = 0;

        CMSampleBufferRef sample;
        while ((sample = [output copyNextSampleBuffer])) {
            @autoreleasepool {
                double t = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sample));
                CVImageBufferRef pixels = CMSampleBufferGetImageBuffer(sample);
                if (!pixels || t < start - 0.001 || (nextDue >= 0 && t < nextDue - 0.002)) {
                    CFRelease(sample);
                    continue;
                }
                if (firstPts < 0) {
                    firstPts = t;
                    wallStart = now();
                }
                nextDue = (nextDue < 0 ? t : nextDue) + 1.0 / fps;
                if (nextDue < t) nextDue = t + 1.0 / fps;

                CGImageRef image = NULL;
                VTCreateCGImageFromCVPixelBuffer(pixels, NULL, &image);
                CFRelease(sample);
                if (!image) continue;
                CGContextDrawImage(ctx, CGRectMake(0, 0, w, h), image);
                CGImageRelease(image);

                double wait = (t - firstPts) - (now() - wallStart);
                if (wait > 0) usleep((useconds_t)(wait * 1e6));

                {
                    CGImageRef frame = CGBitmapContextCreateImage(ctx);
                    NSMutableData *png = [NSMutableData data];
                    CGImageDestinationRef dest = CGImageDestinationCreateWithData((__bridge CFMutableDataRef)png, CFSTR("public.png"), 1, NULL);
                    CGImageDestinationAddImage(dest, frame, NULL);
                    CGImageDestinationFinalize(dest);
                    CFRelease(dest);
                    CGImageRelease(frame);
                    out([NSString stringWithFormat:@"FRAME %.3f %@", t, [png base64EncodedStringWithOptions:0]]);
                }
                sent++;
            }
        }
        out([NSString stringWithFormat:@"END %d", sent]);
        CGContextRelease(ctx);
        CGColorSpaceRelease(space);
    }
    return 0;
}
