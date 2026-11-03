-- Alerts for social posts due today run every hour, so they arrive even when no one opens the planner
DO $$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'social-due-alerts';
  PERFORM cron.schedule('social-due-alerts', '5 * * * *', 'SELECT social.send_due_alerts()');
END;
$$;
