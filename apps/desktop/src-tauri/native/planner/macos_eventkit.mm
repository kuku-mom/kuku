#import <AppKit/AppKit.h>
#import <EventKit/EventKit.h>
#import <CommonCrypto/CommonDigest.h>
#include <cstdint>

// Every EventKit read/write stays on Queue(). Writes require a selected,
// writable calendar and an exact item reference with a fresh version.
namespace {
using Reply = void (^)(id result, NSString *error);
using Callback = void (*)(const char *, void *);

dispatch_queue_t Queue() {
  static dispatch_queue_t queue;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ queue = dispatch_queue_create("mom.kuku.planner.eventkit", DISPATCH_QUEUE_SERIAL); });
  return queue;
}

NSUserDefaults *plannerPreferences;
NSUserDefaults *Preferences() { return plannerPreferences ?: NSUserDefaults.standardUserDefaults; }

EKEventStore *store;
id observer;
uint64_t revision = 0;
uint64_t generations[2] = {0, 0};
bool connecting[2] = {false, false};
NSInteger observedAuthorization[2] = {-1, -1};

NSUInteger Index(NSString *kind) { return [kind isEqualToString:@"reminders"] ? 1 : 0; }
EKEntityType Entity(NSString *kind) { return Index(kind) ? EKEntityTypeReminder : EKEntityTypeEvent; }
NSString *Provider(NSString *kind) { return Index(kind) ? @"apple-reminders" : @"apple-calendar"; }
NSString *ApplicationBundle(NSString *kind) {
  if ([kind isEqualToString:@"calendar"]) return @"com.apple.iCal";
  if ([kind isEqualToString:@"reminders"]) return @"com.apple.reminders";
  return nil;
}
NSString *Preference(NSString *kind) { return [@"planner.apple.connected." stringByAppendingString:kind]; }
bool Enabled(NSString *kind) { return [Preferences() boolForKey:Preference(kind)]; }

bool Authorized(NSString *kind) {
  EKAuthorizationStatus status = [EKEventStore authorizationStatusForEntityType:Entity(kind)];
  if (@available(macOS 14.0, *)) return status == EKAuthorizationStatusFullAccess;
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
  return status == EKAuthorizationStatusAuthorized;
#pragma clang diagnostic pop
}

NSString *AuthorizationError(NSString *kind) {
  switch ([EKEventStore authorizationStatusForEntityType:Entity(kind)]) {
    case EKAuthorizationStatusDenied:
      return @"Apple access was denied or revoked. Enable access in System Settings > Privacy & Security, then reconnect.";
    case EKAuthorizationStatusRestricted:
      return @"Apple access is restricted by this Mac's settings.";
    default:
      return @"Connect this Apple source to access your calendars or reminders.";
  }
}

NSDictionary *Status(NSString *kind) {
  NSMutableDictionary *result = [@{@"provider": Provider(kind), @"connected": @(Enabled(kind) && Authorized(kind)), @"configured": @YES, @"writable": @(Enabled(kind) && Authorized(kind))} mutableCopy];
  if (Enabled(kind) && !Authorized(kind)) result[@"error"] = AuthorizationError(kind);
  return result;
}

EKEventStore *Store() {
  if (!store) store = [[EKEventStore alloc] init];
  if (!observer && ((Enabled(@"calendar") && Authorized(@"calendar")) || (Enabled(@"reminders") && Authorized(@"reminders")))) {
    observer = [NSNotificationCenter.defaultCenter addObserverForName:EKEventStoreChangedNotification object:store queue:nil usingBlock:^(NSNotification *) {
      dispatch_async(Queue(), ^{ ++revision; });
    }];
  }
  return store;
}

void ReleaseUnusedStore() {
  if (!(Enabled(@"calendar") && Authorized(@"calendar")) && !(Enabled(@"reminders") && Authorized(@"reminders"))) {
    if (observer) [NSNotificationCenter.defaultCenter removeObserver:observer];
    observer = nil;
    if (!connecting[0] && !connecting[1]) store = nil;
  }
}

void ObserveAuthorization() {
  for (NSString *kind in @[@"calendar", @"reminders"]) {
    NSUInteger index = Index(kind);
    NSInteger status = [EKEventStore authorizationStatusForEntityType:Entity(kind)];
    if (observedAuthorization[index] != -1 && observedAuthorization[index] != status) {
      ++revision;
      // Permission revocation is not guaranteed to publish an EventKit store
      // change notification. Invalidate pending reads when the poll detects it.
      if (!Authorized(kind)) ++generations[index];
    }
    observedAuthorization[index] = status;
  }
  ReleaseUnusedStore();
}

void OpenApplication(NSString *kind, Reply reply) {
  NSString *bundleID = ApplicationBundle(kind);
  if (!bundleID) { reply(nil, @"Invalid Apple application."); return; }
  dispatch_async(dispatch_get_main_queue(), ^{
    NSWorkspace *workspace = NSWorkspace.sharedWorkspace;
    NSURL *url = [workspace URLForApplicationWithBundleIdentifier:bundleID];
    if (!url) {
      dispatch_async(Queue(), ^{ reply(nil, @"The Apple application is not installed on this Mac."); });
      return;
    }
    NSWorkspaceOpenConfiguration *configuration = NSWorkspaceOpenConfiguration.configuration;
    configuration.activates = YES;
    configuration.addsToRecentItems = NO;
    [workspace openApplicationAtURL:url configuration:configuration completionHandler:^(NSRunningApplication *application, NSError *error) {
      dispatch_async(Queue(), ^{
        if (application) reply(NSNull.null, nil);
        else reply(nil, error.localizedDescription ?: @"Could not open the Apple application.");
      });
    }];
  });
}

NSDate *ParseDate(NSString *value) {
  NSISO8601DateFormatter *format = [[NSISO8601DateFormatter alloc] init];
  format.formatOptions = NSISO8601DateFormatWithInternetDateTime | NSISO8601DateFormatWithFractionalSeconds;
  NSDate *date = [format dateFromString:value];
  if (!date) {
    format.formatOptions = NSISO8601DateFormatWithInternetDateTime;
    date = [format dateFromString:value];
  }
  return date;
}

NSString *Timestamp(NSDate *date) {
  if (!date) return nil;
  return [[[NSISO8601DateFormatter alloc] init] stringFromDate:date];
}

NSString *DateOnly(NSDate *date, NSTimeZone *zone) {
  if (!date) return nil;
  NSDateFormatter *format = [[NSDateFormatter alloc] init];
  format.locale = [[NSLocale alloc] initWithLocaleIdentifier:@"en_US_POSIX"];
  format.calendar = [[NSCalendar alloc] initWithCalendarIdentifier:NSCalendarIdentifierGregorian];
  format.timeZone = zone;
  format.dateFormat = @"yyyy-MM-dd";
  return [format stringFromDate:date];
}

bool Within(NSDate *date, NSDate *start, NSDate *end) {
  return date && [date compare:start] != NSOrderedAscending && [date compare:end] == NSOrderedAscending;
}

NSString *Color(CGColorRef color) {
  if (!color) return nil;
  NSColor *rgb = [[NSColor colorWithCGColor:color] colorUsingColorSpace:NSColorSpace.sRGBColorSpace];
  if (!rgb) return nil;
  return [NSString stringWithFormat:@"#%02x%02x%02x", (int)lround(rgb.redComponent * 255), (int)lround(rgb.greenComponent * 255), (int)lround(rgb.blueComponent * 255)];
}

NSDictionary *CalendarJSON(EKCalendar *calendar, NSString *kind) {
  NSMutableDictionary *result = [@{@"id": calendar.calendarIdentifier, @"provider": Provider(kind), @"title": calendar.title ?: @"", @"writable": @(calendar.allowsContentModifications)} mutableCopy];
  if (calendar.source.sourceIdentifier) result[@"accountId"] = calendar.source.sourceIdentifier;
  if (calendar.source.title) result[@"sourceTitle"] = calendar.source.title;
  NSString *color = Color(calendar.CGColor);
  if (color) result[@"color"] = color;
  return result;
}

NSString *OperationMarker(NSString *operationID) {
  return [NSString stringWithFormat:@"<!-- kuku-planner-operation:%@ -->", operationID];
}

NSString *OperationID(NSString *notes) {
  if (!notes.length) return nil;
  NSRegularExpression *expression = [NSRegularExpression regularExpressionWithPattern:@"<!-- kuku-planner-operation:([0-9a-fA-F-]{36}) -->" options:0 error:nil];
  NSTextCheckingResult *match = [expression firstMatchInString:notes options:0 range:NSMakeRange(0, notes.length)];
  if (!match) return nil;
  NSString *identifier = [notes substringWithRange:[match rangeAtIndex:1]];
  return [[NSUUID alloc] initWithUUIDString:identifier] ? identifier : nil;
}

NSString *Description(NSString *notes) {
  NSString *identifier = OperationID(notes);
  if (!identifier) return notes;
  NSString *marker = OperationMarker(identifier);
  if ([notes hasSuffix:[@"\n\n" stringByAppendingString:marker]]) return [notes substringToIndex:notes.length - marker.length - 2];
  return [notes stringByReplacingOccurrencesOfString:marker withString:@""];
}

NSString *Notes(NSString *description, NSString *operationID) {
  if (!operationID) return description;
  return description.length ? [NSString stringWithFormat:@"%@\n\n%@", description, OperationMarker(operationID)] : OperationMarker(operationID);
}

bool Writable(EKCalendarItem *item, NSString *kind) {
  return item.calendar.allowsContentModifications && (Index(kind) || !item.hasAttendees);
}

NSString *Version(EKCalendarItem *item, NSString *kind) {
  NSMutableArray *fields = [@[
    item.calendar.calendarIdentifier ?: @"", item.calendarItemIdentifier ?: @"",
    item.title ?: @"", item.location ?: @"", item.notes ?: @"", item.URL.absoluteString ?: @"",
    Timestamp(item.lastModifiedDate) ?: @"", item.timeZone.name ?: @"", @(Writable(item, kind)),
  ] mutableCopy];
  if (Index(kind)) {
    EKReminder *reminder = (EKReminder *)item;
    NSDateComponents *due = reminder.dueDateComponents;
    [fields addObjectsFromArray:@[@(reminder.completed), Timestamp(reminder.completionDate) ?: @"", due ? @[@(due.year), @(due.month), @(due.day), @(due.hour), @(due.minute), @(due.second), due.timeZone.name ?: @""] : @[]]];
  } else {
    EKEvent *event = (EKEvent *)item;
    [fields addObjectsFromArray:@[Timestamp(event.startDate) ?: @"", Timestamp(event.endDate) ?: @"", Timestamp(event.occurrenceDate) ?: @"", @(event.allDay), @(event.status)]];
  }
  NSData *data = [NSJSONSerialization dataWithJSONObject:fields options:0 error:nil];
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(data.bytes, (CC_LONG)data.length, digest);
  NSMutableString *result = [NSMutableString string];
  for (NSUInteger index = 0; index < CC_SHA256_DIGEST_LENGTH; ++index) [result appendFormat:@"%02x", digest[index]];
  return result;
}

void AddWriteFields(NSMutableDictionary *result, EKCalendarItem *item, NSString *kind) {
  NSMutableDictionary *reference = [@{@"provider": Provider(kind), @"calendarId": item.calendar.calendarIdentifier,
    @"itemId": item.calendarItemIdentifier, @"version": Version(item, kind)} mutableCopy];
  if (item.calendarItemExternalIdentifier) reference[@"externalId"] = item.calendarItemExternalIdentifier;
  for (NSString *field in @[@"occurrence", @"start", @"end"]) if (result[field]) reference[field] = result[field];
  result[@"writeRef"] = reference;
  result[@"writable"] = @(Writable(item, kind));
  if (item.location) result[@"location"] = item.location;
  NSString *description = Description(item.notes);
  if (description) result[@"description"] = description;
  NSString *operationID = OperationID(item.notes);
  if (operationID) result[@"operationId"] = operationID;
}

NSDictionary *EventJSON(EKEvent *event, NSTimeZone *fallbackZone) {
  if (!event.calendarItemIdentifier || !event.calendar.calendarIdentifier || !event.startDate || !event.endDate || event.status == EKEventStatusCanceled) return nil;
  // EventKit returns floating/all-day dates in the process's default zone.
  // Formatting those instants in the visible calendar zone would shift dates.
  NSTimeZone *zone = event.allDay ? NSTimeZone.defaultTimeZone : (event.timeZone ?: fallbackZone);
  NSDate *endDate = event.endDate;
  if (event.allDay) {
    NSCalendar *calendar = [[NSCalendar alloc] initWithCalendarIdentifier:NSCalendarIdentifierGregorian];
    calendar.timeZone = zone;
    NSDate *firstDay = [calendar startOfDayForDate:event.startDate];
    NSDate *minimumEnd = [calendar dateByAddingUnit:NSCalendarUnitDay value:1 toDate:firstDay options:0];
    // Some subscribed holidays end on their start date. The Planner uses an
    // exclusive date boundary, so a one-day event must span at least one day.
    if ([endDate compare:minimumEnd] == NSOrderedAscending) endDate = minimumEnd;
  }
  // occurrenceDate is the original recurrence slot and remains stable when an
  // individual occurrence is moved. Never identify a recurrence by its new start.
  NSDate *originalDate = event.occurrenceDate;
  NSString *occurrence = originalDate ? (event.allDay ? DateOnly(originalDate, NSTimeZone.defaultTimeZone) : Timestamp(originalDate)) : nil;
  NSString *externalID = event.calendarItemExternalIdentifier ?: event.calendarItemIdentifier;
  NSString *identifier = occurrence ? [NSString stringWithFormat:@"%@/%@/%@", event.calendar.calendarIdentifier, externalID, occurrence] : [NSString stringWithFormat:@"%@/%@", event.calendar.calendarIdentifier, externalID];
  NSMutableDictionary *result = [@{
    @"id": identifier, @"externalId": externalID,
    @"calendarId": event.calendar.calendarIdentifier, @"provider": @"apple-calendar",
    @"title": event.title ?: @"", @"kind": @"event", @"allDay": @(event.allDay),
    @"start": event.allDay ? DateOnly(event.startDate, zone) : Timestamp(event.startDate),
    @"end": event.allDay ? DateOnly(endDate, zone) : Timestamp(endDate),
    @"timeZone": zone.name,
  } mutableCopy];
  if (occurrence) result[@"occurrence"] = occurrence;
  if (event.URL.absoluteString) result[@"url"] = event.URL.absoluteString;
  AddWriteFields(result, event, @"calendar");
  return result;
}

NSDictionary *ReminderJSON(EKReminder *reminder, NSDate *start, NSDate *end, NSTimeZone *zone) {
  if (!reminder.calendarItemIdentifier || !reminder.calendar.calendarIdentifier) return nil;
  NSDateComponents *components = reminder.dueDateComponents;
  NSCalendar *calendar = [components.calendar copy] ?: [[NSCalendar alloc] initWithCalendarIdentifier:NSCalendarIdentifierGregorian];
  calendar.timeZone = components.timeZone ?: zone;
  NSDate *due = components ? [calendar dateFromComponents:components] : nil;
  // Include outstanding undated/overdue reminders alongside this week's items.
  // Completed reminders are bounded to the visible period.
  if (start && end && reminder.completed) {
    if (!Within(reminder.completionDate, start, end) && !Within(due, start, end)) return nil;
  } else if (end && due && [due compare:end] != NSOrderedAscending) return nil;
  NSString *externalID = reminder.calendarItemExternalIdentifier ?: reminder.calendarItemIdentifier;
  NSMutableDictionary *result = [@{
    @"id": [NSString stringWithFormat:@"%@/%@", reminder.calendar.calendarIdentifier, reminder.calendarItemIdentifier],
    @"externalId": externalID, @"calendarId": reminder.calendar.calendarIdentifier,
    @"provider": @"apple-reminders", @"title": reminder.title ?: @"", @"kind": @"reminder",
    @"allDay": @(!components || components.hour == NSDateComponentUndefined),
    @"completed": @(reminder.completed), @"timeZone": calendar.timeZone.name,
  } mutableCopy];
  if (due) {
    result[@"dueDate"] = DateOnly(due, calendar.timeZone);
    if (components.hour != NSDateComponentUndefined) result[@"start"] = Timestamp(due);
  }
  if (reminder.URL.absoluteString) result[@"url"] = reminder.URL.absoluteString;
  AddWriteFields(result, reminder, @"reminders");
  return result;
}

NSDate *DateValue(id value, NSTimeZone *zone) {
  if (![value isKindOfClass:NSString.class]) return nil;
  if ([value length] != 10) return ParseDate(value);
  NSDateFormatter *formatter = [[NSDateFormatter alloc] init];
  formatter.locale = [[NSLocale alloc] initWithLocaleIdentifier:@"en_US_POSIX"];
  formatter.calendar = [[NSCalendar alloc] initWithCalendarIdentifier:NSCalendarIdentifierGregorian];
  formatter.timeZone = zone;
  formatter.dateFormat = @"yyyy-MM-dd";
  formatter.lenient = NO;
  NSDate *date = [formatter dateFromString:value];
  return date && [[formatter stringFromDate:date] isEqualToString:value] ? date : nil;
}

NSDictionary *ItemJSON(EKCalendarItem *item, NSString *kind) {
  return Index(kind) ? ReminderJSON((EKReminder *)item, nil, nil, NSTimeZone.defaultTimeZone) : EventJSON((EKEvent *)item, NSTimeZone.defaultTimeZone);
}

bool Matches(EKCalendarItem *item, NSDictionary *reference, NSString *kind) {
  if (!item || ![item.calendar.calendarIdentifier isEqualToString:reference[@"calendarId"]]) return false;
  if (Index(kind) ? ![item isKindOfClass:EKReminder.class] : ![item isKindOfClass:EKEvent.class]) return false;
  bool identity = [item.calendarItemIdentifier isEqualToString:reference[@"itemId"]] ||
    ([reference[@"externalId"] isKindOfClass:NSString.class] && [item.calendarItemExternalIdentifier isEqualToString:reference[@"externalId"]]);
  if (!identity) return false;
  if (!Index(kind)) {
    NSString *occurrence = ItemJSON(item, kind)[@"occurrence"];
    NSString *expected = reference[@"occurrence"];
    if (occurrence || expected) return [occurrence isEqualToString:expected];
  }
  return true;
}

// Identifier lookups return the first recurring occurrence. Range predicates
// are necessary to resolve the exact visible instance, including moved ones.
EKCalendarItem *Resolve(EKEventStore *eventStore, NSString *kind, NSDictionary *reference, NSString **error) {
  // Calendar IDs are device-local. A synced note may refer to another Mac's
  // calendar, or an account that is no longer available. Neither proves that
  // the event was deleted, so callers must not clear a note's time block.
  EKCalendar *calendar = nil;
  for (EKCalendar *available in [eventStore calendarsForEntityType:Entity(kind)]) {
    if ([available.calendarIdentifier isEqualToString:reference[@"calendarId"]]) {
      calendar = available; break;
    }
  }
  if (!calendar) {
    *error = @"CONFLICT: The referenced Apple calendar is unavailable on this Mac. Reconnect or select the matching calendar.";
    return nil;
  }
  NSMutableArray<EKCalendarItem *> *candidates = [NSMutableArray array];
  EKCalendarItem *direct = [eventStore calendarItemWithIdentifier:reference[@"itemId"]];
  bool identityStillExists = direct != nil;
  if (Matches(direct, reference, kind)) [candidates addObject:direct];
  if (!candidates.count && [reference[@"externalId"] isKindOfClass:NSString.class]) {
    for (EKCalendarItem *item in [eventStore calendarItemsWithExternalIdentifier:reference[@"externalId"]]) {
      identityStillExists = true;
      if (Matches(item, reference, kind)) [candidates addObject:item];
    }
  }
  if (!Index(kind) && [reference[@"occurrence"] isKindOfClass:NSString.class]) {
    [candidates removeAllObjects];
    {
      NSMutableSet *seen = [NSMutableSet set];
      for (id anchor in @[reference[@"start"] ?: NSNull.null, reference[@"occurrence"] ?: NSNull.null]) {
        NSDate *date = DateValue(anchor, NSTimeZone.defaultTimeZone);
        if (!date) continue;
        NSDate *rangeStart = [date dateByAddingTimeInterval:-86400];
        NSDate *rangeEnd = [date dateByAddingTimeInterval:2 * 86400];
        for (EKEvent *event in [eventStore eventsMatchingPredicate:[eventStore predicateForEventsWithStartDate:rangeStart endDate:rangeEnd calendars:@[calendar]]]) {
          if (!Matches(event, reference, kind)) continue;
          NSString *key = [NSString stringWithFormat:@"%@/%@", event.calendarItemIdentifier, Timestamp(event.occurrenceDate)];
          if (![seen containsObject:key]) { [seen addObject:key]; [candidates addObject:event]; }
        }
      }
    }
  }
  if (candidates.count > 1) {
    *error = @"CONFLICT: Multiple Apple items match this reference. Refresh before editing.";
    return nil;
  }
  if (!candidates.count && (identityStillExists || reference[@"occurrence"])) {
    *error = @"CONFLICT: This Apple item moved or its occurrence changed. Refresh before editing.";
  }
  return candidates.firstObject;
}

// Validate the complete proposed state before changing an EventKit object.
// A rejected patch must not leave unsaved changes in the event store's objects.
NSString *ApplyPatch(EKCalendarItem *item, NSString *kind, NSDictionary *patch, bool creating, NSString *operationID) {
  NSMutableDictionary *proposed = creating ? [@{@"allDay": @NO, @"timeZone": NSTimeZone.defaultTimeZone.name} mutableCopy] : [ItemJSON(item, kind) mutableCopy];
  if (!proposed) return @"NOT_FOUND: This Apple item no longer exists.";
  [proposed addEntriesFromDictionary:patch];
  NSString *title = proposed[@"title"];
  if (![title isKindOfClass:NSString.class] || ![title stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet].length) return @"An item title is required.";
  NSString *zoneName = proposed[@"timeZone"];
  NSTimeZone *zone = [zoneName isKindOfClass:NSString.class] ? [NSTimeZone timeZoneWithName:zoneName] : NSTimeZone.defaultTimeZone;
  if (!zone) return @"Invalid Apple item time zone.";
  bool allDay = [proposed[@"allDay"] boolValue];
  NSDate *start = nil, *end = nil;
  NSDateComponents *due = nil;
  if (!Index(kind)) {
    if (allDay && (![proposed[@"start"] isKindOfClass:NSString.class] || [proposed[@"start"] length] != 10 || ![proposed[@"end"] isKindOfClass:NSString.class] || [proposed[@"end"] length] != 10)) return @"All-day events require date-only start and exclusive end dates.";
    if (!allDay && (![proposed[@"start"] isKindOfClass:NSString.class] || [proposed[@"start"] length] <= 10 || ![proposed[@"end"] isKindOfClass:NSString.class] || [proposed[@"end"] length] <= 10)) return @"Timed events require start and end timestamps with time zones.";
    start = DateValue(proposed[@"start"], allDay ? NSTimeZone.defaultTimeZone : zone);
    end = DateValue(proposed[@"end"], allDay ? NSTimeZone.defaultTimeZone : zone);
    if (!start || !end || [start compare:end] != NSOrderedAscending || [end timeIntervalSinceDate:start] > 366 * 86400) return @"Invalid Apple event date range.";
  } else {
    NSCalendar *calendar = [[NSCalendar alloc] initWithCalendarIdentifier:NSCalendarIdentifierGregorian];
    calendar.timeZone = zone;
    id dateOnly = proposed[@"dueDate"];
    id timed = proposed[@"start"];
    // A due-date patch changes the date independently of a prior time. A null
    // due date clears the due time as well; scheduling uses a separate event.
    if (patch[@"dueDate"] == NSNull.null) timed = nil;
    if ([timed isKindOfClass:NSString.class] && !allDay) {
      NSDate *date = ParseDate(timed);
      if (!date) return @"Invalid reminder due time.";
      due = [calendar components:NSCalendarUnitYear | NSCalendarUnitMonth | NSCalendarUnitDay | NSCalendarUnitHour | NSCalendarUnitMinute | NSCalendarUnitSecond fromDate:date];
    }
    if ([dateOnly isKindOfClass:NSString.class]) {
      NSDate *date = DateValue(dateOnly, zone);
      if (!date || [dateOnly length] != 10) return @"Invalid reminder due date.";
      NSDateComponents *day = [calendar components:NSCalendarUnitYear | NSCalendarUnitMonth | NSCalendarUnitDay fromDate:date];
      if (!due) due = day;
      else if (patch[@"dueDate"] || !patch[@"start"]) { due.year = day.year; due.month = day.month; due.day = day.day; }
    } else if (dateOnly && dateOnly != NSNull.null) return @"Invalid reminder due date.";
    if (due) { due.timeZone = zone; due.calendar = calendar; }
  }
  item.title = title;
  if (patch[@"location"]) item.location = patch[@"location"] == NSNull.null ? nil : patch[@"location"];
  if (patch[@"description"] || creating) {
    id description = proposed[@"description"];
    item.notes = Notes([description isKindOfClass:NSString.class] ? description : nil, operationID ?: OperationID(item.notes));
  }
  if (!Index(kind) && (creating || patch[@"start"] || patch[@"end"] || patch[@"allDay"] || patch[@"timeZone"])) {
    EKEvent *event = (EKEvent *)item;
    event.allDay = allDay;
    event.timeZone = allDay ? nil : zone;
    event.startDate = start; event.endDate = end;
  } else if (Index(kind)) {
    EKReminder *reminder = (EKReminder *)item;
    if (creating || patch[@"dueDate"] || patch[@"start"] || patch[@"allDay"] || patch[@"timeZone"]) reminder.dueDateComponents = due;
    if (patch[@"completed"]) reminder.completed = [patch[@"completed"] boolValue];
  }
  return nil;
}

NSString *LedgerKey(NSString *kind) { return [@"planner.apple.operations." stringByAppendingString:kind]; }
NSMutableDictionary *Ledger(NSString *kind) { return [[Preferences() dictionaryForKey:LedgerKey(kind)] mutableCopy] ?: [NSMutableDictionary dictionary]; }
void RecordOperation(NSString *kind, NSString *operationID, NSDictionary *record) {
  NSMutableDictionary *ledger = Ledger(kind);
  if (record) ledger[operationID] = record; else [ledger removeObjectForKey:operationID];
  [Preferences() setObject:ledger forKey:LedgerKey(kind)];
}

void FetchReminders(EKEventStore *eventStore, NSArray *calendars, Reply reply) {
  uint64_t generation = generations[1];
  __block bool finished = false;
  id token = [eventStore fetchRemindersMatchingPredicate:[eventStore predicateForRemindersInCalendars:calendars] completion:^(NSArray<EKReminder *> *reminders) {
    dispatch_async(Queue(), ^{
      if (finished) return;
      finished = true;
      if (generation != generations[1] || !Enabled(@"reminders") || !Authorized(@"reminders")) { reply(nil, @"Apple Reminders access changed. Reconnect and retry."); return; }
      reply(reminders, reminders ? nil : @"Could not fetch Apple Reminders.");
    });
  }];
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 30 * NSEC_PER_SEC), Queue(), ^{
    if (finished) return;
    finished = true; [eventStore cancelFetchRequest:token]; reply(nil, @"Apple Reminders did not respond. Try refreshing.");
  });
}

void CreateItem(EKEventStore *eventStore, NSString *kind, EKCalendar *calendar, NSDictionary *request, NSArray<EKCalendarItem *> *items, Reply reply) {
  NSString *operationID = request[@"operationId"];
  if (![[NSUUID alloc] initWithUUIDString:operationID]) { reply(nil, @"Invalid Apple operation ID."); return; }
  NSDictionary *record = Ledger(kind)[operationID];
  if (record[@"disconnected"]) { reply(nil, @"CONFLICT: This operation predates an Apple disconnect. Refresh and use a new operation only after checking the original calendar."); return; }
  if (record && ![record[@"calendarId"] isEqualToString:calendar.calendarIdentifier]) { reply(nil, @"CONFLICT: This operation belongs to another calendar."); return; }
  // Reconcile a lost response using the marker before considering creation.
  NSMutableArray *matches = [NSMutableArray array];
  if (record[@"ref"]) {
    NSString *lookupError = nil;
    EKCalendarItem *existing = Resolve(eventStore, kind, record[@"ref"], &lookupError);
    if (lookupError) { reply(nil, lookupError); return; }
    if (existing && [OperationID(existing.notes) caseInsensitiveCompare:operationID] == NSOrderedSame && OperationID(existing.notes)) [matches addObject:existing];
  }
  if (!matches.count) for (EKCalendarItem *item in items) if ([OperationID(item.notes) caseInsensitiveCompare:operationID] == NSOrderedSame && OperationID(item.notes)) [matches addObject:item];
  if (matches.count > 1) { reply(nil, @"CONFLICT: Multiple Apple items have this operation ID."); return; }
  if (matches.count == 1) { reply(ItemJSON(matches.firstObject, kind), nil); return; }
  if (record) { reply(nil, @"CONFLICT: The earlier Apple creation result is uncertain or was deleted. Refresh before trying a new operation."); return; }
  if (!calendar.allowsContentModifications) { reply(nil, @"READ_ONLY: This Apple calendar cannot be modified."); return; }
  EKCalendarItem *item = Index(kind) ? (EKCalendarItem *)[EKReminder reminderWithEventStore:eventStore] : (EKCalendarItem *)[EKEvent eventWithEventStore:eventStore];
  item.calendar = calendar;
  NSString *validation = ApplyPatch(item, kind, request[@"draft"], true, operationID);
  if (validation) { reply(nil, validation); return; }
  RecordOperation(kind, operationID, @{@"calendarId": calendar.calendarIdentifier, @"pending": @YES});
  NSError *error = nil;
  bool saved = Index(kind) ? [eventStore saveReminder:(EKReminder *)item commit:YES error:&error] : [eventStore saveEvent:(EKEvent *)item span:EKSpanThisEvent commit:YES error:&error];
  if (!saved) { [eventStore reset]; RecordOperation(kind, operationID, nil); reply(nil, error.localizedDescription ?: @"Apple could not save this item."); return; }
  ++revision;
  NSDictionary *result = ItemJSON(item, kind);
  if (!result) { reply(nil, @"Apple saved the item but did not return its identity. Refresh before retrying."); return; }
  RecordOperation(kind, operationID, @{@"calendarId": calendar.calendarIdentifier, @"ref": result[@"writeRef"]});
  reply(result, nil);
}

void Mutate(EKEventStore *eventStore, NSString *kind, NSDictionary *request, Reply reply) {
  NSString *operation = request[@"operation"];
  if ([operation isEqualToString:@"create"]) {
    EKCalendar *calendar = [eventStore calendarWithIdentifier:request[@"calendarId"]];
    if (!calendar || !(calendar.allowedEntityTypes & (Index(kind) ? EKEntityMaskReminder : EKEntityMaskEvent))) { reply(nil, @"NOT_FOUND: This Apple calendar is unavailable."); return; }
    if (!calendar.allowsContentModifications) { reply(nil, @"READ_ONLY: This Apple calendar cannot be modified."); return; }
    if (Index(kind)) {
      FetchReminders(eventStore, @[calendar], ^(id items, NSString *error) {
        if (error) reply(nil, error); else CreateItem(eventStore, kind, calendar, request, items, reply);
      });
    } else {
      NSDictionary *draft = request[@"draft"];
      NSDate *start = DateValue(draft[@"start"], NSTimeZone.defaultTimeZone), *end = DateValue(draft[@"end"], NSTimeZone.defaultTimeZone);
      if (!start || !end || [start compare:end] != NSOrderedAscending || [end timeIntervalSinceDate:start] > 366 * 86400) { reply(nil, @"Invalid event date range."); return; }
      NSArray *items = [eventStore eventsMatchingPredicate:[eventStore predicateForEventsWithStartDate:[start dateByAddingTimeInterval:-86400] endDate:[end dateByAddingTimeInterval:86400] calendars:@[calendar]]];
      CreateItem(eventStore, kind, calendar, request, items, reply);
    }
    return;
  }
  NSString *lookupError = nil;
  EKCalendarItem *item = Resolve(eventStore, kind, request[@"ref"], &lookupError);
  if (lookupError) { reply(nil, lookupError); return; }
  if ([operation isEqualToString:@"get"]) { reply(item ? ItemJSON(item, kind) : NSNull.null, nil); return; }
  if (!item) { reply(nil, @"NOT_FOUND: This Apple item no longer exists or its occurrence moved. Refresh before editing."); return; }
  if (!Writable(item, kind)) { reply(nil, @"READ_ONLY: This item is in a read-only calendar or has meeting attendees."); return; }
  if (![Version(item, kind) isEqualToString:request[@"ref"][@"version"]]) { reply(nil, @"CONFLICT: This Apple item changed. Refresh before editing."); return; }
  NSError *error = nil;
  bool saved;
  if ([operation isEqualToString:@"delete"]) {
    saved = Index(kind) ? [eventStore removeReminder:(EKReminder *)item commit:YES error:&error] : [eventStore removeEvent:(EKEvent *)item span:EKSpanThisEvent commit:YES error:&error];
  } else {
    NSString *validation = ApplyPatch(item, kind, request[@"patch"], false, nil);
    if (validation) { reply(nil, validation); return; }
    saved = Index(kind) ? [eventStore saveReminder:(EKReminder *)item commit:YES error:&error] : [eventStore saveEvent:(EKEvent *)item span:EKSpanThisEvent commit:YES error:&error];
  }
  if (!saved) { [eventStore reset]; reply(nil, error.localizedDescription ?: @"Apple could not save this change."); return; }
  ++revision;
  reply([operation isEqualToString:@"delete"] ? NSNull.null : ItemJSON(item, kind), nil);
}

void Connect(NSString *kind, Reply reply) {
  NSUInteger index = Index(kind);
  if (connecting[index]) { reply(nil, @"An Apple permission request is already open."); return; }
  if (Authorized(kind)) {
    [Preferences() setBool:YES forKey:Preference(kind)];
    Store();
    ++revision;
    reply(Status(kind), nil);
    return;
  }
  connecting[index] = true;
  uint64_t generation = generations[index];
  EKEventStore *requestStore = Store();
  void (^completion)(BOOL, NSError *) = ^(BOOL granted, NSError *error) {
    dispatch_async(Queue(), ^{
      connecting[index] = false;
      if (generation != generations[index]) {
        ReleaseUnusedStore();
        reply(nil, @"Apple connection was cancelled.");
        return;
      }
      bool allowed = granted && Authorized(kind);
      [Preferences() setBool:allowed forKey:Preference(kind)];
      if (allowed) Store(); else ReleaseUnusedStore();
      ++revision;
      if (allowed) reply(Status(kind), nil);
      else reply(nil, error.localizedDescription ?: AuthorizationError(kind));
    });
  };
  if (@available(macOS 14.0, *)) {
    if (index) [requestStore requestFullAccessToRemindersWithCompletion:completion];
    else [requestStore requestFullAccessToEventsWithCompletion:completion];
  } else {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
    [requestStore requestAccessToEntityType:Entity(kind) completion:completion];
#pragma clang diagnostic pop
  }
}

void HandleRequest(NSDictionary *request, Reply reply) {
  NSString *operation = request[@"operation"];
  if ([operation isEqualToString:@"revision"]) { ObserveAuthorization(); reply(@(revision), nil); return; }
  if ([operation isEqualToString:@"suspend"]) {
    ++generations[0]; ++generations[1];
    if (observer) [NSNotificationCenter.defaultCenter removeObserver:observer];
    observer = nil; store = nil;
    reply(NSNull.null, nil); return;
  }
  NSString *kind = request[@"kind"];
  if (![kind isEqualToString:@"calendar"] && ![kind isEqualToString:@"reminders"]) { reply(nil, @"Invalid Apple source."); return; }
  if ([operation isEqualToString:@"open-app"]) { OpenApplication(kind, reply); return; }
  if ([operation isEqualToString:@"status"]) {
    if (Enabled(kind) && Authorized(kind)) Store(); else ReleaseUnusedStore();
    reply(Status(kind), nil); return;
  }
  if ([operation isEqualToString:@"connect"]) { Connect(kind, reply); return; }
  if ([operation isEqualToString:@"disconnect"]) {
    ++generations[Index(kind)];
    [Preferences() setBool:NO forKey:Preference(kind)];
    // Discard external identities but retain opaque operation tombstones: an
    // old uncertain creation must not become a new event after reconnecting.
    NSMutableDictionary *operations = Ledger(kind);
    for (NSString *operationID in operations.allKeys) operations[operationID] = @{@"disconnected": @YES};
    [Preferences() setObject:operations forKey:LedgerKey(kind)];
    ReleaseUnusedStore(); ++revision;
    reply(NSNull.null, nil); return;
  }
  if (!Enabled(kind) || !Authorized(kind)) {
    ReleaseUnusedStore(); reply(nil, [@"AUTH: " stringByAppendingString:AuthorizationError(kind)]); return;
  }
  EKEventStore *requestStore = Store();
  if ([@[@"get", @"create", @"update", @"delete"] containsObject:operation]) {
    Mutate(requestStore, kind, request, ^(id result, NSString *error) {
      // Access may have changed during a native lookup. An empty result after
      // revocation is not confirmed deletion either.
      if (!Enabled(kind) || !Authorized(kind)) reply(nil, [@"AUTH: " stringByAppendingString:AuthorizationError(kind)]);
      else reply(result, error);
    }); return;
  }
  NSArray<EKCalendar *> *calendars = [requestStore calendarsForEntityType:Entity(kind)];
  if ([operation isEqualToString:@"calendars"]) {
    NSMutableArray *result = [NSMutableArray array];
    EKCalendar *defaultCalendar = Index(kind) ? requestStore.defaultCalendarForNewReminders : requestStore.defaultCalendarForNewEvents;
    for (EKCalendar *calendar in calendars) {
      NSMutableDictionary *json = [CalendarJSON(calendar, kind) mutableCopy];
      json[@"isDefault"] = @([calendar.calendarIdentifier isEqualToString:defaultCalendar.calendarIdentifier]);
      [result addObject:json];
    }
    reply(result, nil); return;
  }
  if (![operation isEqualToString:@"items"]) { reply(nil, @"Unsupported Apple operation."); return; }
  NSArray<NSString *> *ids = request[@"calendarIds"];
  NSDate *start = ParseDate(request[@"start"]), *end = ParseDate(request[@"end"]);
  NSTimeZone *zone = [NSTimeZone timeZoneWithName:request[@"timeZone"]];
  if (!start || !end || [start compare:end] != NSOrderedAscending || !zone || ![ids isKindOfClass:NSArray.class]) { reply(nil, @"Invalid Apple date range, time zone, or calendar selection."); return; }
  NSMutableArray *selected = [NSMutableArray array];
  for (EKCalendar *calendar in calendars) if ([ids containsObject:calendar.calendarIdentifier]) [selected addObject:calendar];
  // EventKit interprets nil calendars as all calendars. An empty explicit
  // selection must remain empty, including when a calendar has been removed.
  if (!selected.count) { reply(@[], nil); return; }
  if (!Index(kind)) {
    NSPredicate *predicate = [requestStore predicateForEventsWithStartDate:start endDate:end calendars:selected];
    NSArray<EKEvent *> *events = [requestStore eventsMatchingPredicate:predicate];
    if (!Authorized(kind)) { ReleaseUnusedStore(); reply(nil, AuthorizationError(kind)); return; }
    NSMutableArray *result = [NSMutableArray array];
    for (EKEvent *event in events) { NSDictionary *json = EventJSON(event, zone); if (json) [result addObject:json]; }
    reply(result, nil); return;
  }
  uint64_t generation = generations[Index(kind)];
  __block bool finished = false;
  NSPredicate *predicate = [requestStore predicateForRemindersInCalendars:selected];
  id token = [requestStore fetchRemindersMatchingPredicate:predicate completion:^(NSArray<EKReminder *> *reminders) {
    dispatch_async(Queue(), ^{
      if (finished) return;
      finished = true;
      if (generation != generations[Index(kind)] || !Enabled(kind)) { reply(nil, @"Apple connection was disconnected."); return; }
      if (!Authorized(kind)) { ReleaseUnusedStore(); reply(nil, AuthorizationError(kind)); return; }
      if (!reminders) { reply(nil, @"Could not fetch Apple Reminders. Try refreshing."); return; }
      NSMutableArray *result = [NSMutableArray array];
      for (EKReminder *reminder in reminders) { NSDictionary *json = ReminderJSON(reminder, start, end, zone); if (json) [result addObject:json]; }
      reply(result, nil);
    });
  }];
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 30 * NSEC_PER_SEC), Queue(), ^{
    if (finished) return;
    finished = true;
    [requestStore cancelFetchRequest:token];
    reply(nil, @"Apple Reminders did not respond. Try refreshing.");
  });
}
}  // namespace

extern "C" void kuku_planner_apple_request(const char *input, Callback callback, void *context) {
  @autoreleasepool {
    // Copy immediately: Rust frees the input as soon as this function returns.
    NSString *text = input ? [NSString stringWithUTF8String:input] : nil;
    dispatch_async(Queue(), ^{
      @autoreleasepool {
        Reply reply = ^(id result, NSString *error) {
          NSDictionary *envelope = error ? @{@"error": error} : @{@"ok": result ?: NSNull.null};
          NSData *data = [NSJSONSerialization dataWithJSONObject:envelope options:0 error:nil];
          NSString *json = data ? [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] : @"{\"error\":\"EventKit serialization failed\"}";
          callback(json.UTF8String, context);
        };
        @try {
          NSData *data = [text dataUsingEncoding:NSUTF8StringEncoding];
          id request = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
          if (![request isKindOfClass:NSDictionary.class]) reply(nil, @"Invalid EventKit request.");
          else HandleRequest(request, reply);
        } @catch (NSException *) { reply(nil, @"EventKit could not complete the request. Check Apple permissions and try again."); }
      }
    });
  }
}
