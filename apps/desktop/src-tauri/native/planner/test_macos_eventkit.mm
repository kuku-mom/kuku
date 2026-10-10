// Pure serialization regression tests: no EKEventStore, permissions, or reads
// of the user's calendars/reminders are needed.
#include "macos_eventkit.mm"
#include <cassert>
#include <iostream>

@interface PlannerTestCalendar : NSObject
@property(nonatomic, copy) NSString *calendarIdentifier;
@property(nonatomic) BOOL allowsContentModifications;
@end
@implementation PlannerTestCalendar
@end

@interface PlannerTestEvent : NSObject
@property(nonatomic, copy) NSString *calendarItemIdentifier;
@property(nonatomic, copy) NSString *calendarItemExternalIdentifier;
@property(nonatomic, strong) PlannerTestCalendar *calendar;
@property(nonatomic, strong) NSDate *startDate;
@property(nonatomic, strong) NSDate *endDate;
@property(nonatomic, strong) NSDate *occurrenceDate;
@property(nonatomic, strong) NSTimeZone *timeZone;
@property(nonatomic, copy) NSString *title;
@property(nonatomic, copy) NSString *location;
@property(nonatomic, copy) NSString *notes;
@property(nonatomic, strong) NSDate *lastModifiedDate;
@property(nonatomic) BOOL hasAttendees;
@property(nonatomic, strong) NSURL *URL;
@property(nonatomic) EKEventStatus status;
@property(nonatomic, getter=isAllDay) BOOL allDay;
@end
@implementation PlannerTestEvent
- (BOOL)isKindOfClass:(Class)classType { return classType == EKEvent.class || [super isKindOfClass:classType]; }
@end

@interface PlannerTestReminder : NSObject
@property(nonatomic, copy) NSString *calendarItemIdentifier;
@property(nonatomic, copy) NSString *calendarItemExternalIdentifier;
@property(nonatomic, strong) PlannerTestCalendar *calendar;
@property(nonatomic, strong) NSDateComponents *dueDateComponents;
@property(nonatomic, strong) NSDate *completionDate;
@property(nonatomic, copy) NSString *title;
@property(nonatomic, copy) NSString *location;
@property(nonatomic, copy) NSString *notes;
@property(nonatomic, strong) NSDate *lastModifiedDate;
@property(nonatomic, strong) NSTimeZone *timeZone;
@property(nonatomic) BOOL hasAttendees;
@property(nonatomic, strong) NSURL *URL;
@property(nonatomic, getter=isCompleted) BOOL completed;
@end
@implementation PlannerTestReminder
- (BOOL)isKindOfClass:(Class)classType { return classType == EKReminder.class || [super isKindOfClass:classType]; }
@end

// This fake store records writes; no real EKEventStore is ever constructed.
@interface PlannerTestStore : NSObject
@property(nonatomic, strong) id direct;
@property(nonatomic, strong) NSArray *externalItems;
@property(nonatomic, strong) NSArray *events;
@property(nonatomic, strong) PlannerTestCalendar *calendar;
@property(nonatomic, strong) id lastSaved;
@property(nonatomic, strong) id lastRemoved;
@property(nonatomic) EKSpan span;
@property(nonatomic) NSUInteger saves;
@property(nonatomic) NSUInteger removals;
@end
@implementation PlannerTestStore
- (id)calendarItemWithIdentifier:(NSString *)identifier { return self.direct; }
- (NSArray *)calendarItemsWithExternalIdentifier:(NSString *)identifier { return self.externalItems ?: @[]; }
- (id)calendarWithIdentifier:(NSString *)identifier { return self.calendar; }
- (NSArray *)calendarsForEntityType:(EKEntityType)entity { return self.calendar ? @[self.calendar] : @[]; }
- (id)predicateForEventsWithStartDate:(NSDate *)start endDate:(NSDate *)end calendars:(NSArray *)calendars { return @[start, end]; }
- (NSArray *)eventsMatchingPredicate:(id)predicate { return self.events ?: @[]; }
- (BOOL)saveEvent:(id)event span:(EKSpan)span commit:(BOOL)commit error:(NSError **)error {
  self.lastSaved = event; self.span = span; ++self.saves; assert(commit); return YES;
}
- (BOOL)removeEvent:(id)event span:(EKSpan)span commit:(BOOL)commit error:(NSError **)error {
  self.lastRemoved = event; self.span = span; ++self.removals; assert(commit); return YES;
}
- (BOOL)saveReminder:(id)reminder commit:(BOOL)commit error:(NSError **)error {
  self.lastSaved = reminder; ++self.saves; assert(commit); return YES;
}
- (BOOL)removeReminder:(id)reminder commit:(BOOL)commit error:(NSError **)error {
  self.lastRemoved = reminder; ++self.removals; assert(commit); return YES;
}
@end

int main() {
  @autoreleasepool {
    assert([ApplicationBundle(@"calendar") isEqualToString:@"com.apple.iCal"]);
    assert([ApplicationBundle(@"reminders") isEqualToString:@"com.apple.reminders"]);
    assert(!ApplicationBundle(@"com.apple.Terminal"));
    assert(!ApplicationBundle(@"/Applications/Calendar.app"));
    NSTimeZone *originalZone = NSTimeZone.defaultTimeZone;
    NSTimeZone *la = [NSTimeZone timeZoneWithName:@"America/Los_Angeles"];
    NSTimeZone *seoul = [NSTimeZone timeZoneWithName:@"Asia/Seoul"];
    [NSTimeZone setDefaultTimeZone:la];
    NSDate *weekStart = ParseDate(@"2026-03-02T00:00:00-08:00");
    NSDate *weekEnd = ParseDate(@"2026-03-09T00:00:00-07:00");
    assert(weekStart && weekEnd);
    assert([weekEnd timeIntervalSinceDate:weekStart] == 7 * 86400 - 3600);
    assert([DateOnly(ParseDate(@"2026-03-08T00:00:00-08:00"), la) isEqualToString:@"2026-03-08"]);
    assert(ParseDate(@"2026-03-08T00:00:00.000Z"));
    assert(!ParseDate(@"not-a-date"));

    PlannerTestCalendar *calendar = [[PlannerTestCalendar alloc] init];
    calendar.calendarIdentifier = @"calendar-1";
    calendar.allowsContentModifications = YES;
    PlannerTestEvent *event = [[PlannerTestEvent alloc] init];
    event.calendar = calendar;
    event.calendarItemIdentifier = @"local-1";
    event.calendarItemExternalIdentifier = @"server-1";
    event.title = @"Original";
    event.startDate = ParseDate(@"2026-03-04T10:00:00-08:00");
    event.endDate = ParseDate(@"2026-03-04T10:30:00-08:00");
    NSDictionary *first = EventJSON((EKEvent *)event, la);
    event.startDate = ParseDate(@"2026-03-05T10:00:00-08:00");
    NSDictionary *moved = EventJSON((EKEvent *)event, la);
    assert([first[@"id"] isEqualToString:moved[@"id"]]);
    assert(!first[@"occurrence"]);

    event.occurrenceDate = ParseDate(@"2026-03-04T10:00:00-08:00");
    NSDictionary *detached = EventJSON((EKEvent *)event, la);
    event.startDate = ParseDate(@"2026-03-06T10:00:00-08:00");
    assert([detached[@"id"] isEqualToString:EventJSON((EKEvent *)event, la)[@"id"]]);
    event.occurrenceDate = ParseDate(@"2026-03-11T10:00:00-07:00");
    assert(![detached[@"id"] isEqualToString:EventJSON((EKEvent *)event, la)[@"id"]]);
    event.status = EKEventStatusCanceled;
    assert(!EventJSON((EKEvent *)event, la));
    event.status = EKEventStatusConfirmed;

    event.allDay = YES;
    event.startDate = ParseDate(@"2026-03-08T00:00:00-08:00");
    event.endDate = ParseDate(@"2026-03-10T00:00:00-07:00");
    event.occurrenceDate = event.startDate;
    NSDictionary *allDay = EventJSON((EKEvent *)event, seoul);
    assert([allDay[@"start"] isEqualToString:@"2026-03-08"]);
    assert([allDay[@"end"] isEqualToString:@"2026-03-10"]);
    assert([allDay[@"occurrence"] isEqualToString:@"2026-03-08"]);
    event.endDate = event.startDate;
    assert([EventJSON((EKEvent *)event, seoul)[@"end"] isEqualToString:@"2026-03-09"]);
    event.endDate = ParseDate(@"2026-03-08T23:59:59-07:00");
    assert([EventJSON((EKEvent *)event, seoul)[@"end"] isEqualToString:@"2026-03-09"]);
    event.startDate = ParseDate(@"2026-11-01T00:00:00-07:00");
    event.endDate = event.startDate;
    assert([EventJSON((EKEvent *)event, seoul)[@"end"] isEqualToString:@"2026-11-02"]);
    event.startDate = ParseDate(@"2026-03-08T00:00:00-08:00");
    event.endDate = ParseDate(@"2026-03-10T00:00:00-07:00");

    PlannerTestReminder *reminder = [[PlannerTestReminder alloc] init];
    reminder.calendar = calendar;
    reminder.calendarItemIdentifier = @"reminder-1";
    reminder.title = @"Reminder";
    NSDictionary *undated = ReminderJSON((EKReminder *)reminder, weekStart, weekEnd, la);
    assert(undated && [undated[@"allDay"] boolValue] && !undated[@"dueDate"]);
    NSDateComponents *due = [[NSDateComponents alloc] init];
    due.year = 2026; due.month = 3; due.day = 1;
    reminder.dueDateComponents = due;
    NSDictionary *overdue = ReminderJSON((EKReminder *)reminder, weekStart, weekEnd, la);
    assert([overdue[@"dueDate"] isEqualToString:@"2026-03-01"] && [overdue[@"allDay"] boolValue]);
    due.day = 10;
    assert(!ReminderJSON((EKReminder *)reminder, weekStart, weekEnd, la));
    due.day = 8; due.hour = 9; due.minute = 30;
    NSDictionary *timed = ReminderJSON((EKReminder *)reminder, weekStart, weekEnd, la);
    assert(![timed[@"allDay"] boolValue]);
    assert([timed[@"start"] isEqualToString:@"2026-03-08T16:30:00Z"]);
    reminder.completed = YES;
    reminder.dueDateComponents = nil;
    assert(!ReminderJSON((EKReminder *)reminder, weekStart, weekEnd, la));
    reminder.completionDate = ParseDate(@"2026-03-03T12:00:00-08:00");
    assert(ReminderJSON((EKReminder *)reminder, weekStart, weekEnd, la));

    // Local IDs and occurrence keys are separate from existing display IDs.
    NSDictionary *writeRef = EventJSON((EKEvent *)event, seoul)[@"writeRef"];
    assert([writeRef[@"itemId"] isEqualToString:@"local-1"]);
    assert([writeRef[@"occurrence"] isEqualToString:@"2026-03-08"]);
    assert([writeRef[@"version"] length] == 64);
    assert(Writable((EKCalendarItem *)event, @"calendar"));
    event.hasAttendees = YES;
    assert(!Writable((EKCalendarItem *)event, @"calendar"));
    event.hasAttendees = NO;
    calendar.allowsContentModifications = NO;
    assert(!Writable((EKCalendarItem *)reminder, @"reminders"));
    calendar.allowsContentModifications = YES;

    NSString *operationID = @"136b95e3-5278-408b-96b7-837af1d6a810";
    event.notes = Notes(@"Original meeting context", operationID);
    assert([OperationID(event.notes) isEqualToString:operationID]);
    assert([Description(event.notes) isEqualToString:@"Original meeting context"]);
    NSString *beforeVersion = Version((EKCalendarItem *)event, @"calendar");
    assert(!ApplyPatch((EKCalendarItem *)event, @"calendar", @{@"title": @"Edited title", @"description": @"Updated context"}, false, nil));
    assert(![beforeVersion isEqualToString:Version((EKCalendarItem *)event, @"calendar")]);
    assert([OperationID(event.notes) isEqualToString:operationID]);
    assert([Description(event.notes) isEqualToString:@"Updated context"]);
    assert(ApplyPatch((EKCalendarItem *)event, @"calendar", @{@"title": @"Must not apply", @"start": @"2026-03-12", @"end": @"2026-03-11"}, false, nil));
    assert([event.title isEqualToString:@"Edited title"]);
    assert(!DateValue(@"2026-02-30", la));

    // Completion preserves the existing due components; due-date clearing is
    // explicit and never happens just because a reminder is put on a calendar.
    reminder.dueDateComponents = due;
    reminder.completed = NO;
    assert(!ApplyPatch((EKCalendarItem *)reminder, @"reminders", @{@"completed": @YES}, false, nil));
    assert(reminder.completed && reminder.dueDateComponents == due);
    assert(!ApplyPatch((EKCalendarItem *)reminder, @"reminders", @{@"dueDate": @"2026-03-09"}, false, nil));
    assert(reminder.dueDateComponents.day == 9 && reminder.dueDateComponents.hour == 9);
    assert(!ApplyPatch((EKCalendarItem *)reminder, @"reminders", @{@"dueDate": NSNull.null}, false, nil));
    assert(!reminder.dueDateComponents);

    PlannerTestStore *fakeStore = [[PlannerTestStore alloc] init];
    fakeStore.calendar = calendar;
    event.allDay = NO; event.timeZone = la;
    event.occurrenceDate = ParseDate(@"2026-03-11T10:00:00-07:00");
    event.startDate = ParseDate(@"2026-03-12T10:00:00-07:00");
    event.endDate = ParseDate(@"2026-03-12T10:30:00-07:00");
    NSDictionary *secondRef = ItemJSON((EKCalendarItem *)event, @"calendar")[@"writeRef"];
    PlannerTestEvent *firstOccurrence = [[PlannerTestEvent alloc] init];
    firstOccurrence.calendar = calendar; firstOccurrence.calendarItemIdentifier = @"local-1";
    firstOccurrence.calendarItemExternalIdentifier = @"server-1";
    firstOccurrence.startDate = ParseDate(@"2026-03-04T10:00:00-08:00");
    firstOccurrence.endDate = ParseDate(@"2026-03-04T10:30:00-08:00");
    firstOccurrence.occurrenceDate = firstOccurrence.startDate;
    fakeStore.direct = firstOccurrence; fakeStore.events = @[firstOccurrence, event];
    NSString *lookupError = nil;
    assert(Resolve((EKEventStore *)fakeStore, @"calendar", secondRef, &lookupError) == (EKCalendarItem *)event);
    assert(!lookupError);
    __block NSString *mutationError = nil;
    __block id mutationResult = nil;
    Reply capture = ^(id result, NSString *error) { mutationResult = result; mutationError = error; };
    Mutate((EKEventStore *)fakeStore, @"calendar", @{@"operation": @"update", @"ref": secondRef, @"patch": @{@"title": @"Only second occurrence"}}, capture);
    assert(!mutationError && mutationResult && fakeStore.saves == 1 && fakeStore.lastSaved == event && fakeStore.span == EKSpanThisEvent);
    assert(![firstOccurrence.title isEqualToString:@"Only second occurrence"]);
    Mutate((EKEventStore *)fakeStore, @"calendar", @{@"operation": @"update", @"ref": secondRef, @"patch": @{@"title": @"Stale edit"}}, capture);
    assert([mutationError hasPrefix:@"CONFLICT:"] && fakeStore.saves == 1);
    event.hasAttendees = YES;
    Mutate((EKEventStore *)fakeStore, @"calendar", @{@"operation": @"delete", @"ref": ItemJSON((EKCalendarItem *)event, @"calendar")[@"writeRef"]}, capture);
    assert([mutationError hasPrefix:@"READ_ONLY:"] && fakeStore.removals == 0);
    event.hasAttendees = NO;
    Mutate((EKEventStore *)fakeStore, @"calendar", @{@"operation": @"delete", @"ref": ItemJSON((EKCalendarItem *)event, @"calendar")[@"writeRef"]}, capture);
    assert(!mutationError && fakeStore.lastRemoved == event && fakeStore.span == EKSpanThisEvent);
    fakeStore.events = @[firstOccurrence];
    lookupError = nil;
    assert(!Resolve((EKEventStore *)fakeStore, @"calendar", secondRef, &lookupError));
    assert([lookupError hasPrefix:@"CONFLICT:"]);

    fakeStore.direct = reminder;
    NSDictionary *reminderRef = ItemJSON((EKCalendarItem *)reminder, @"reminders")[@"writeRef"];
    Mutate((EKEventStore *)fakeStore, @"reminders", @{@"operation": @"update", @"ref": reminderRef, @"patch": @{@"completed": @NO}}, capture);
    assert(!mutationError && !reminder.completed && fakeStore.lastSaved == reminder);
    Mutate((EKEventStore *)fakeStore, @"reminders", @{@"operation": @"delete", @"ref": ItemJSON((EKCalendarItem *)reminder, @"reminders")[@"writeRef"]}, capture);
    assert(!mutationError && fakeStore.lastRemoved == reminder);

    // Device-local calendar IDs from another Mac, and removed accounts, must
    // never be mistaken for a confirmed deletion that clears a note's time.
    fakeStore.direct = nil; fakeStore.externalItems = @[]; fakeStore.events = @[];
    NSDictionary *absentRef = @{@"provider": @"apple-calendar", @"calendarId": @"calendar-1", @"itemId": @"absent-item", @"externalId": @"absent-server-item"};
    Mutate((EKEventStore *)fakeStore, @"calendar", @{@"operation": @"get", @"ref": absentRef}, capture);
    assert(!mutationError && mutationResult == NSNull.null);
    fakeStore.calendar = nil;
    Mutate((EKEventStore *)fakeStore, @"calendar", @{@"operation": @"get", @"ref": absentRef}, capture);
    assert([mutationError hasPrefix:@"CONFLICT:"] && !mutationResult);
    fakeStore.calendar = calendar;
    NSMutableDictionary *otherMacRef = [absentRef mutableCopy];
    otherMacRef[@"calendarId"] = @"another-macs-calendar-id";
    Mutate((EKEventStore *)fakeStore, @"calendar", @{@"operation": @"get", @"ref": otherMacRef}, capture);
    assert([mutationError hasPrefix:@"CONFLICT:"] && !mutationResult);

    // A lost create response is reconciled from the marker without saving a
    // second item. Pending journal entries never silently create duplicates.
    NSString *suite = [@"mom.kuku.planner.tests." stringByAppendingString:NSUUID.UUID.UUIDString];
    plannerPreferences = [[NSUserDefaults alloc] initWithSuiteName:suite];
    NSDictionary *createRequest = @{@"operationId": operationID};
    NSUInteger originalSaves = fakeStore.saves;
    CreateItem((EKEventStore *)fakeStore, @"calendar", (EKCalendar *)calendar, createRequest, @[(EKCalendarItem *)event], capture);
    assert(!mutationError && [mutationResult[@"operationId"] isEqualToString:operationID] && fakeStore.saves == originalSaves);
    RecordOperation(@"calendar", operationID, @{@"calendarId": calendar.calendarIdentifier, @"pending": @YES});
    CreateItem((EKEventStore *)fakeStore, @"calendar", (EKCalendar *)calendar, createRequest, @[], capture);
    assert([mutationError hasPrefix:@"CONFLICT:"] && fakeStore.saves == originalSaves);
    [plannerPreferences removePersistentDomainForName:suite];
    plannerPreferences = nil;
    [NSTimeZone setDefaultTimeZone:originalZone];
    std::cout << "EventKit date, exact occurrence writes, read-only, conflict, reminder and retry contracts passed\n";
  }
}
