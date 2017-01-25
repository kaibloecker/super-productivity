/**
 * @ngdoc service
 * @name superProductivity.Tasks
 * @description
 * # Tasks
 * Service in the superProductivity.
 */

(function () {
  'use strict';

  const IPC_EVENT_IDLE = 'WAS_IDLE';
  const IPC_EVENT_UPDATE_TIME_SPEND_FOR_CURRENT = 'UPDATE_TIME_SPEND';
  const IPC_EVENT_CURRENT_TASK_UPDATED = 'CHANGED_CURRENT_TASK';
  const WORKLOG_DATE_STR_FORMAT = 'YYYY-MM-DD';

  /* @ngInject */
  class Tasks {

    constructor($localStorage, Uid, $rootScope, Dialogs, IS_ELECTRON, $mdToast, SimpleToast, Notifier, ShortSyntax, ParseDuration) {
      this.$localStorage = $localStorage;
      this.Uid = Uid;
      this.$rootScope = $rootScope;
      this.Dialogs = Dialogs;
      this.$mdToast = $mdToast;
      this.SimpleToast = SimpleToast;
      this.Notifier = Notifier;
      this.ShortSyntax = ShortSyntax;
      this.ParseDuration = ParseDuration;

      this.isShowTakeBreakNotification = true;

      // SETUP HANDLERS FOR ELECTRON EVENTS
      if (IS_ELECTRON) {
        let that = this;

        let isIdleDialogOpen = false;
        // handler for time spent tracking
        window.ipcRenderer.on(IPC_EVENT_UPDATE_TIME_SPEND_FOR_CURRENT, (ev, evData) => {
          if (!isIdleDialogOpen) {
            let timeSpentInMs = evData.timeSpentInMs;
            let idleTimeInMs = evData.idleTimeInMs;

            // only track if there is a task
            if (this.$rootScope.r.currentTask) {

              that.addTimeSpent(this.$rootScope.r.currentTask, timeSpentInMs);
              that.updateCurrent(this.$rootScope.r.currentTask, true);
              that.checkTakeToTakeABreak(timeSpentInMs, idleTimeInMs);

              // we need to manually call apply as this is an outside event
              this.$rootScope.$apply();
            }
          }
        });

        // handler for idle event
        window.ipcRenderer.on(IPC_EVENT_IDLE, (ev, params) => {
          const idleTime = params.idleTimeInMs;
          const minIdleTimeInMs = params.minIdleTimeInMs;

          // do not show as long as the user hasn't decided
          this.isShowTakeBreakNotification = false;

          if (!isIdleDialogOpen) {
            isIdleDialogOpen = true;
            this.Dialogs('WAS_IDLE', { idleTime, minIdleTimeInMs })
              .then(() => {
                // if tracked
                this.checkTakeToTakeABreak(idleTime);
                this.isShowTakeBreakNotification = true;
                isIdleDialogOpen = false;
              }, () => {
                // if not tracked
                // unset currentSession.timeWorkedWithoutBreak
                this.$rootScope.r.currentSession.timeWorkedWithoutBreak = undefined;
                this.isShowTakeBreakNotification = true;
                isIdleDialogOpen = false;
              });
          }
        });
      }
    }

    checkTakeToTakeABreak(timeSpentInMs, idleTimeInMs) {
      const MIN_IDLE_VAL_TO_TAKE_A_BREAK_FROM_TAKE_A_BREAK = 9999;

      if (this.$rootScope.r.config && this.$rootScope.r.config.isTakeABreakEnabled) {
        if (!this.$rootScope.r.currentSession) {
          this.$rootScope.r.currentSession = {};
        }
        // add or create moment duration for timeWorkedWithoutBreak
        if (this.$rootScope.r.currentSession.timeWorkedWithoutBreak) {
          // convert to moment to be save
          this.$rootScope.r.currentSession.timeWorkedWithoutBreak = moment.duration(this.$rootScope.r.currentSession.timeWorkedWithoutBreak);
          this.$rootScope.r.currentSession.timeWorkedWithoutBreak.add(moment.duration({ milliseconds: timeSpentInMs }));
        } else {
          this.$rootScope.r.currentSession.timeWorkedWithoutBreak = moment.duration(timeSpentInMs);
        }

        if (moment.duration(this.$rootScope.r.config.takeABreakMinWorkingTime)
            .asSeconds() < this.$rootScope.r.currentSession.timeWorkedWithoutBreak.asSeconds()) {

          if (idleTimeInMs > MIN_IDLE_VAL_TO_TAKE_A_BREAK_FROM_TAKE_A_BREAK) {
            return;
          }

          if (this.isShowTakeBreakNotification) {
            let toast = this.$mdToast.simple()
              .textContent('Take a break! You have been working for ' + this.ParseDuration.toString(this.$rootScope.r.currentSession.timeWorkedWithoutBreak) + ' without one. Go away from the computer! Makes you more productive in the long run!')
              .action('I already did!')
              .hideDelay(20000)
              .position('bottom');
            this.$mdToast.show(toast).then(function (response) {
              if (response === 'ok') {
                // re-add task on undo
                this.$rootScope.r.currentSession.timeWorkedWithoutBreak = undefined;
              }
            });

            this.Notifier({
              title: 'Take a break!',
              message: 'Take a break! You have been working for ' + this.ParseDuration.toString(this.$rootScope.r.currentSession.timeWorkedWithoutBreak) + ' without one. Go away from the computer! Makes you more productive in the long run!',
              sound: true,
              wait: true
            });
          }
        }
      }
    }

    removeTimeSpent(task, timeSpentToRemoveAsMoment) {
      const TODAY_STR = this.constructor.getTodayStr();
      let timeSpentToRemoveInMs;
      let timeSpentCalculatedOnDay;
      let parentTask;

      if (timeSpentToRemoveAsMoment.asMilliseconds) {
        timeSpentToRemoveInMs = timeSpentToRemoveAsMoment.asMilliseconds();
      } else {
        timeSpentToRemoveInMs = timeSpentToRemoveAsMoment;
      }

      // track time spent on days
      if (!task.timeSpentOnDay) {
        task.timeSpentOnDay = {};
      }
      if (task.timeSpentOnDay[TODAY_STR]) {
        // convert to moment again in case it messed up
        timeSpentCalculatedOnDay = moment.duration(task.timeSpentOnDay[TODAY_STR]);
        timeSpentCalculatedOnDay.subtract(timeSpentToRemoveInMs, 'milliseconds');
        if (timeSpentCalculatedOnDay.asSeconds() > 0) {
          task.timeSpentOnDay[TODAY_STR] = timeSpentCalculatedOnDay;
        } else {
          delete task.timeSpentOnDay[TODAY_STR];
        }
      }

      // do the same for the parent, in case the sub tasks are deleted
      if (task.parentId) {
        parentTask = this.getById(task.parentId);
        parentTask.timeSpentOnDay = this.mergeTotalTimeSpentOnDayFrom(parentTask.subTasks);
      }

      // track total time spent
      task.timeSpent = this.calcTotalTimeSpentOnTask(task);

      return task;
    }

    addTimeSpent(task, timeSpentInMsOrMomentDuration) {
      // use mysql date as it is sortable
      const TODAY_STR = this.constructor.getTodayStr();
      let timeSpentCalculatedOnDay;
      let timeSpentInMs;
      let parentTask;

      if (timeSpentInMsOrMomentDuration.asMilliseconds) {
        timeSpentInMs = timeSpentInMsOrMomentDuration.asMilliseconds();
      } else {
        timeSpentInMs = timeSpentInMsOrMomentDuration;
      }

      // if not set set started pointer
      if (!task.started) {
        task.started = moment();
      }

      // track time spent on days
      if (!task.timeSpentOnDay) {
        task.timeSpentOnDay = {};
      }
      if (task.timeSpentOnDay[TODAY_STR]) {
        timeSpentCalculatedOnDay = moment.duration(task.timeSpentOnDay[TODAY_STR]);
        timeSpentCalculatedOnDay.add(moment.duration({ milliseconds: timeSpentInMs }));
      } else {
        timeSpentCalculatedOnDay = moment.duration({ milliseconds: timeSpentInMs });
      }

      // assign values
      task.timeSpentOnDay[TODAY_STR] = timeSpentCalculatedOnDay;
      task.lastWorkedOn = moment();

      // do the same for the parent, in case the sub tasks are deleted
      if (task.parentId) {
        parentTask = this.getById(task.parentId);
        // also set parent task to started if there is one
        if (!parentTask.started) {
          parentTask.started = moment();
        }

        // also track time spent on day for parent task
        parentTask.timeSpentOnDay = this.mergeTotalTimeSpentOnDayFrom(parentTask.subTasks);
        parentTask.lastWorkedOn = moment();
      }

      // track total time spent
      task.timeSpent = this.calcTotalTimeSpentOnTask(task);

      return task;
    }

    // UTILITY
    convertDurationStringsToMomentForList(tasks) {
      if (tasks) {
        _.each(tasks, (task) => {
          this.constructor.convertDurationStringsToMoment(task);
          if (task.subTasks) {
            _.each(task.subTasks, this.constructor.convertDurationStringsToMoment);
          }
        });
      }
    }

    static convertDurationStringsToMoment(task) {
      if (task.timeSpent) {
        task.timeSpent = moment.duration(task.timeSpent);
      }
      if (task.timeEstimate) {
        task.timeEstimate = moment.duration(task.timeEstimate);
      }
      if (task.timeSpentOnDay) {
        _.forOwn(task.timeSpentOnDay, (val, strDate) => {
          task.timeSpentOnDay[strDate] = moment.duration(task.timeSpentOnDay[strDate]);
        });
      }
    }

    static getTodayStr() {
      return moment().format(WORKLOG_DATE_STR_FORMAT);
    }

    static formatToWorklogDateStr(date) {
      if (date) {
        return moment(date).format(WORKLOG_DATE_STR_FORMAT);
      }
    }

    static deleteNullValueTasks(tasksArray) {
      return tasksArray.filter(function (item) {
        return !!item;
      });
    }

    checkDupes(tasksArray) {
      if (tasksArray) {
        this.constructor.deleteNullValueTasks(tasksArray);
        let valueArr = tasksArray.map(function (item) {
          return item && item.id;
        });
        let dupeIds = [];
        let hasDupe = valueArr.some(function (item, idx) {
          if (valueArr.indexOf(item) !== idx) {
            dupeIds.push(item);
          }
          return valueArr.indexOf(item) !== idx;
        });
        if (dupeIds.length) {
          let firstDupe = _.find(tasksArray, (task) => {
            return dupeIds.indexOf(task.id) > -1;
          });
          console.log(firstDupe);

          this.SimpleToast('!!! Dupes detected in data for the ids: ' + dupeIds.join(', ') + '. First task title is "' + firstDupe.title + '" !!!', 60000);
        }
        return hasDupe;
      }
    }

    calcTotalEstimate(tasks) {
      let totalEstimate;
      if (angular.isArray(tasks) && tasks.length > 0) {
        totalEstimate = moment.duration();
        _.each(tasks, (task) => {
          totalEstimate.add(task.timeEstimate);
        });
      }
      return totalEstimate;
    }

    calcTotalTimeSpent(tasks) {
      let totalTimeSpent;
      if (angular.isArray(tasks) && tasks.length > 0) {
        totalTimeSpent = moment.duration();

        _.each(tasks, (task) => {
          if (task && task.timeSpent) {
            totalTimeSpent.add(task.timeSpent);
          }
        });
      }
      return totalTimeSpent;
    }

    calcTotalTimeSpentOnDay(tasks, dayStr) {
      let totalTimeSpentOnDay;
      if (angular.isArray(tasks) && tasks.length > 0) {
        totalTimeSpentOnDay = moment.duration();

        _.each(tasks, (task) => {
          if (task && task.timeSpentOnDay && task.timeSpentOnDay[dayStr]) {
            totalTimeSpentOnDay.add(task.timeSpentOnDay[dayStr]);
          }
        });
      }
      return totalTimeSpentOnDay;
    }

    mergeTotalTimeSpentOnDayFrom(tasks) {
      let totalTimeSpentOnDay = {};
      if (angular.isArray(tasks) && tasks.length > 0) {
        _.each(tasks, (task) => {
          if (task && task.timeSpentOnDay) {
            _.forOwn(task.timeSpentOnDay, (val, strDate) => {
              if (!totalTimeSpentOnDay[strDate]) {
                totalTimeSpentOnDay[strDate] = moment.duration();
              }
              totalTimeSpentOnDay[strDate].add(task.timeSpentOnDay[strDate]);
            });
          }
        });
      }
      return totalTimeSpentOnDay;
    }

    calcTotalTimeSpentOnTask(task) {
      let totalTimeSpent = moment.duration();
      if (task) {
        _.forOwn(task.timeSpentOnDay, (val, strDate) => {
          if (task.timeSpentOnDay[strDate]) {
            totalTimeSpent.add(moment.duration(task.timeSpentOnDay[strDate]).asSeconds(), 's');
          }
        });

        if (totalTimeSpent.asMinutes() > 0) {
          return totalTimeSpent;
        } else {
          return undefined;
        }
      }
    }

    calcRemainingTime(tasks) {
      let totalRemaining;
      if (angular.isArray(tasks) && tasks.length > 0) {
        totalRemaining = moment.duration();

        _.each(tasks, (task) => {
          if (task) {
            if (task.timeSpent && task.timeEstimate) {
              let timeSpentMilliseconds = moment.duration(task.timeSpent).asMilliseconds();
              let timeEstimateMilliseconds = moment.duration(task.timeEstimate).asMilliseconds();
              if (timeSpentMilliseconds < timeEstimateMilliseconds) {
                totalRemaining.add(moment.duration({ milliseconds: timeEstimateMilliseconds - timeSpentMilliseconds }));
              }
            } else if (task.timeEstimate) {
              totalRemaining.add(task.timeEstimate);
            }
          }
        });
      }
      return totalRemaining;

    }

    // GET DATA
    getCurrent() {
      let currentTask;
      let subTaskMatch;

      // we want to sync the ls current task with the this.$rootScope current task
      // that's why we load the current task from the ls directly
      if (this.$localStorage.currentTask) {
        currentTask = _.find(this.$localStorage.tasks, (task) => {
          if (task.subTasks) {
            let subTaskMatchTmp = _.find(task.subTasks, { id: this.$localStorage.currentTask.id });
            if (subTaskMatchTmp) {
              subTaskMatch = subTaskMatchTmp;
            }
          }
          return task.id === this.$localStorage.currentTask.id;
        });

        this.$localStorage.currentTask = this.$rootScope.r.currentTask = currentTask || subTaskMatch;
      }
      return this.$rootScope.r.currentTask;
    }

    getById(taskId) {
      return _.find(this.$rootScope.r.tasks, ['id', taskId]) || _.find(this.$rootScope.r.backlogTasks, ['id', taskId]) || _.find(this.$rootScope.r.doneBacklogTasks, ['id', taskId]);
    }

    getBacklog() {
      this.checkDupes(this.$localStorage.backlogTasks);
      this.convertDurationStringsToMomentForList(this.$localStorage.backlogTasks);
      return this.$localStorage.backlogTasks;
    }

    getDoneBacklog() {
      this.checkDupes(this.$localStorage.doneBacklogTasks);
      this.convertDurationStringsToMomentForList(this.$localStorage.doneBacklogTasks);
      return this.$localStorage.doneBacklogTasks;
    }

    getToday() {
      this.checkDupes(this.$localStorage.tasks);
      this.convertDurationStringsToMomentForList(this.$localStorage.tasks);
      return this.$localStorage.tasks;
    }

    getAllTasks() {
      const todaysT = this.getToday();
      const backlogT = this.getBacklog();
      const doneBacklogT = this.getDoneBacklog();

      return _.concat(todaysT, backlogT, doneBacklogT);
    }

    flattenTasks(tasks, checkFnParent, checkFnSub) {
      const flattenedTasks = [];
      _.each(tasks, (parentTask) => {

        if (parentTask) {
          if (parentTask.subTasks && parentTask.subTasks.length > 0) {
            _.each(parentTask.subTasks, (subTask) => {
              // execute check fn if there is one
              if (angular.isFunction(checkFnSub)) {
                if (checkFnSub(subTask)) {
                  flattenedTasks.push(subTask);
                }
              }
              // otherwise just add
              else {
                flattenedTasks.push(subTask);
              }
            });
          } else {
            // execute check fn if there is one
            if (angular.isFunction(checkFnParent)) {
              if (checkFnParent(parentTask)) {
                flattenedTasks.push(parentTask);
              }
            }
            // otherwise just add
            else {
              flattenedTasks.push(parentTask);
            }
          }
        }
      });

      return flattenedTasks;
    }

    getCompleteWorkLog() {
      const allTasks = this.flattenTasks(this.getAllTasks());
      const worklog = {};
      _.each(allTasks, (task) => {
        if (task.timeSpentOnDay) {
          _.forOwn(task.timeSpentOnDay, (val, dateStr) => {
            if (task.timeSpentOnDay[dateStr]) {
              const split = dateStr.split('-');
              const year = parseInt(split[0], 10);
              const month = parseInt(split[1], 10);
              const day = parseInt(split[2], 10);

              if (!worklog[year]) {
                worklog[year] = {
                  timeSpent: moment.duration(),
                  entries: {}
                };
              }
              if (!worklog[year].entries[month]) {
                worklog[year].entries[month] = {
                  timeSpent: moment.duration(),
                  entries: {}
                };
              }
              if (!worklog[year].entries[month].entries[day]) {
                worklog[year].entries[month].entries[day] = {
                  timeSpent: moment.duration(),
                  entries: [],
                  dateStr: dateStr,
                  id: this.Uid()
                };
              }

              worklog[year].entries[month].entries[day].timeSpent = worklog[year].entries[month].entries[day].timeSpent.add(task.timeSpentOnDay[dateStr]);
              worklog[year].entries[month].entries[day].entries.push({
                task: task,
                timeSpent: moment.duration(task.timeSpentOnDay[dateStr])
              });
            }
          });
        }
      });

      // calculate time spent totals once too
      _.forOwn(worklog, (val, key) => {
        let year = worklog[key];
        _.forOwn(year.entries, (val, key) => {
          let month = year.entries[key];
          _.forOwn(month.entries, (val, key) => {
            let day = month.entries[key];
            month.timeSpent = month.timeSpent.add(day.timeSpent);
          });

          year.timeSpent = year.timeSpent.add(month.timeSpent);
        });
      });

      return worklog;
    }

    getUndoneToday(isSubTasksInsteadOfParent) {
      let undoneTasks;

      // get flattened result of all undone tasks including subtasks
      if (isSubTasksInsteadOfParent) {
        // get all undone tasks tasks
        undoneTasks = this.flattenTasks(this.$localStorage.tasks, (parentTask) => {
          return parentTask && !parentTask.isDone;
        }, (subTask) => {
          return !subTask.isDone;
        });
      }

      // just get parent undone tasks
      else {
        undoneTasks = _.filter(this.$localStorage.tasks, (task) => {
          return task && !task.isDone;
        });
      }

      return undoneTasks;
    }

    getDoneToday() {
      return _.filter(this.$localStorage.tasks, (task) => {
        return task && task.isDone;
      });
    }

    isWorkedOnToday(task) {
      let todayStr = this.constructor.getTodayStr();
      return task && task.timeSpentOnDay && task.timeSpentOnDay[todayStr];
    }

    getTotalTimeWorkedOnTasksToday() {
      let tasks = this.getToday();
      let totalTimeSpentTasks = moment.duration();
      if (tasks) {
        _.each(tasks, (task) => {
          totalTimeSpentTasks.add(task.timeSpent);
        });
      }
      return totalTimeSpentTasks;
    }

    getTimeWorkedToday() {
      let tasks = this.getToday();
      let todayStr = this.constructor.getTodayStr();
      let totalTimeWorkedToday;
      if (tasks.length > 0) {
        totalTimeWorkedToday = moment.duration();
        _.each(tasks, (task) => {
          if (task.subTasks && task.subTasks.length) {
            _.each(task.subTasks, (subTask) => {
              if (subTask.timeSpentOnDay && subTask.timeSpentOnDay[todayStr]) {
                totalTimeWorkedToday.add(subTask.timeSpentOnDay[todayStr]);
              }
            });
          } else {
            if (task.timeSpentOnDay && task.timeSpentOnDay[todayStr]) {
              totalTimeWorkedToday.add(task.timeSpentOnDay[todayStr]);
            }
          }
        });
      }
      return totalTimeWorkedToday;
    }

    // UPDATE DATA
    updateCurrent(task, isCallFromTimeTracking) {
      // calc progress
      if (task && task.timeSpent && task.timeEstimate) {
        if (moment.duration().format && angular.isFunction(moment.duration().format)) {
          task.progress = parseInt(moment.duration(task.timeSpent)
              .format('ss') / moment.duration(task.timeEstimate).format('ss') * 100, 10);
        }
      }

      // update totalTimeSpent for buggy macos
      if (task) {
        task.timeSpent = this.calcTotalTimeSpentOnTask(task);
      }

      // check if in electron context
      if (window.isElectron) {
        if (!isCallFromTimeTracking) {
          if (task && task.originalKey) {
            //Jira.markAsInProgress(task);
          }
        }

        if (task && task.title) {
          window.ipcRenderer.send(IPC_EVENT_CURRENT_TASK_UPDATED, task);
        }
      }

      this.$localStorage.currentTask = task;
      // update global pointer
      this.$rootScope.r.currentTask = this.$localStorage.currentTask;
    }

    addToday(task) {
      if (task && task.title) {
        this.$localStorage.tasks.push(this.createTask(task));

        // update global pointer for today tasks
        this.$rootScope.r.tasks = this.$localStorage.tasks;

        return true;
      }
    }

    createTask(task) {
      let transformedTask = {
        title: task.title,
        id: this.Uid(),
        created: moment(),
        notes: task.notes,
        parentId: task.parentId,
        timeEstimate: task.timeEstimate || task.originalEstimate,
        timeSpent: task.timeSpent || task.originalTimeSpent,
        originalId: task.originalId,
        originalKey: task.originalKey,
        originalType: task.originalType,
        originalLink: task.originalLink,
        originalStatus: task.originalStatus,
        originalEstimate: task.originalEstimate,
        originalTimeSpent: task.originalTimeSpent,
        originalAttachment: task.originalAttachment,
        originalComments: task.originalComments,
        originalUpdated: task.originalUpdated
      };
      return this.ShortSyntax(transformedTask);
    }

    updateToday(tasks) {
      this.$localStorage.tasks = tasks;
      // update global pointer
      this.$rootScope.r.tasks = this.$localStorage.tasks;
    }

    updateBacklog(tasks) {
      this.$localStorage.backlogTasks = tasks;
      // update global pointer
      this.$rootScope.r.backlogTasks = this.$localStorage.backlogTasks;
    }

    addTasksToTopOfBacklog(tasks) {
      this.$localStorage.backlogTasks = tasks.concat(this.$localStorage.backlogTasks);
      // update global pointer
      this.$rootScope.r.backlogTasks = this.$localStorage.backlogTasks;
    }

    updateDoneBacklog(tasks) {
      this.$localStorage.doneBacklogTasks = tasks;
      // update global pointer
      this.$rootScope.r.doneBacklogTasks = this.$localStorage.doneBacklogTasks;
    }

    addDoneTasksToDoneBacklog() {
      let doneTasks = this.getDoneToday().slice(0);
      this.$localStorage.doneBacklogTasks = doneTasks.concat(this.$localStorage.doneBacklogTasks);
      // update global pointer
      this.$rootScope.r.doneBacklogTasks = this.$localStorage.doneBacklogTasks;
    }

    finishDay(clearDoneTasks, moveUnfinishedToBacklog) {
      if (clearDoneTasks) {
        // add tasks to done backlog
        this.addDoneTasksToDoneBacklog();
        // remove done tasks from today
        this.updateToday(this.getUndoneToday());
      }

      if (moveUnfinishedToBacklog) {
        this.addTasksToTopOfBacklog(this.getUndoneToday());
        if (clearDoneTasks) {
          this.updateToday([]);
        } else {
          this.updateToday(this.getDoneToday());
        }
      }

      // also remove the current task to prevent time tracking
      this.updateCurrent(null);
    }
  }

  angular
    .module('superProductivity')
    .service('Tasks', Tasks);

})();
