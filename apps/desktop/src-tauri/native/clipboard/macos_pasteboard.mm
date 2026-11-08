#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>

#include <cstdlib>
#include <cstring>

extern "C" char *kuku_macos_read_clipboard_payload() {
  @autoreleasepool {
    NSPasteboard *pb = [NSPasteboard generalPasteboard];
    if (!pb) return nullptr;

    // 1. Check if an image file URL was copied in Finder
    NSArray<NSURL *> *urls = [pb
        readObjectsForClasses:@[ [NSURL class] ]
                      options:@{NSPasteboardURLReadingFileURLsOnlyKey : @YES}];
    if (urls.count > 0) {
      NSSet<NSString *> *imageExts = [NSSet setWithArray:@[
        @"png", @"jpg", @"jpeg", @"gif", @"webp", @"svg", @"avif", @"bmp",
        @"ico"
      ]];
      for (NSURL *fileUrl in urls) {
        NSString *ext = fileUrl.pathExtension.lowercaseString;
        if (ext && [imageExts containsObject:ext] && fileUrl.path) {
          NSString *res = [NSString stringWithFormat:@"FILE:%@", fileUrl.path];
          return strdup(res.UTF8String);
        }
      }
    }

    // 2. Check for direct PNG data on the pasteboard
    NSData *pngData = [pb dataForType:NSPasteboardTypePNG];
    if (pngData && pngData.length > 0) {
      NSString *b64 = [pngData base64EncodedStringWithOptions:0];
      if (b64) {
        NSString *res =
            [NSString stringWithFormat:@"DATA:data:image/png;base64,%@", b64];
        return strdup(res.UTF8String);
      }
    }

    // 3. Check for TIFF / NSImage bitmap on the pasteboard (screenshots, copied images)
    NSImage *image = [[NSImage alloc] initWithPasteboard:pb];
    if (image) {
      NSData *tiffData = image.TIFFRepresentation;
      if (tiffData) {
        NSBitmapImageRep *rep = [NSBitmapImageRep imageRepWithData:tiffData];
        if (rep) {
          NSData *convertedPng =
              [rep representationUsingType:NSBitmapImageFileTypePNG
                                properties:@{}];
          if (convertedPng && convertedPng.length > 0) {
            NSString *b64 = [convertedPng base64EncodedStringWithOptions:0];
            if (b64) {
              NSString *res = [NSString
                  stringWithFormat:@"DATA:data:image/png;base64,%@", b64];
              return strdup(res.UTF8String);
            }
          }
        }
      }
    }

    // 4. Fall back to plain string (image URL or markdown image syntax)
    NSString *str = [pb stringForType:NSPasteboardTypeString];
    if (str && str.length > 0) {
      NSString *res = [NSString stringWithFormat:@"TEXT:%@", str];
      return strdup(res.UTF8String);
    }

    return nullptr;
  }
}

extern "C" void kuku_macos_free_clipboard_payload(char *ptr) {
  if (ptr) {
    std::free(ptr);
  }
}
