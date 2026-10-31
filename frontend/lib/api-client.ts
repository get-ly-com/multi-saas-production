import axios, { AxiosInstance } from 'axios';

export class APIClient {
  private client: AxiosInstance;
  private tenantId: string;

  constructor(tenantId: string = 'default') {
    this.tenantId = tenantId;
    this.client = axios.create({
      baseURL: process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:3000',
      headers: {
        'x-tenant-id': tenantId,
        'Authorization': typeof window !== 'undefined' ? `Bearer ${localStorage.getItem('token') || ''}` : ''
      }
    });
  }

  // Accounting
  getInvoices() { return this.client.get('/api/accounting/invoices'); }
  createInvoice(data: any) { return this.client.post('/api/accounting/invoices', data); }
  updateInvoice(id: string, data: any) { return this.client.put(`/api/accounting/invoices/${id}`, data); }
  deleteInvoice(id: string) { return this.client.delete(`/api/accounting/invoices/${id}`); }
  getAnalytics() { return this.client.get('/api/accounting/analytics'); }

  // CRM
  getContacts() { return this.client.get('/api/crm/contacts'); }
  createContact(data: any) { return this.client.post('/api/crm/contacts', data); }
  getDeals() { return this.client.get('/api/crm/deals'); }
  createDeal(data: any) { return this.client.post('/api/crm/deals', data); }

  // Inventory
  getItems() { return this.client.get('/api/inventory/items'); }
  createItem(data: any) { return this.client.post('/api/inventory/items', data); }
  updateStock(id: string, quantity: number) { return this.client.patch(`/api/inventory/items/${id}`, { quantity }); }

  // Chatbot
  sendMessage(message: string) { return this.client.post('/api/chatbot/chat', { message }); }
  getConversations() { return this.client.get('/api/chatbot/conversations'); }

  // Video
  createRoom() { return this.client.post('/api/video/rooms', {}); }
  getRoom(roomId: string) { return this.client.get(`/api/video/rooms/${roomId}`); }

  // Scheduler
  getAppointments() { return this.client.get('/api/scheduler/appointments'); }
  createAppointment(data: any) { return this.client.post('/api/scheduler/appointments', data); }

  // HR
  getEmployees() { return this.client.get('/api/hr/employees'); }
  createEmployee(data: any) { return this.client.post('/api/hr/employees', data); }
  getPayroll() { return this.client.get('/api/hr/payroll'); }

  // Social Media
  getPosts() { return this.client.get('/api/social-media/posts'); }
  createPost(data: any) { return this.client.post('/api/social-media/posts', data); }
  publishPost(postId: string) { return this.client.post('/api/social-media/publish', { postId }); }

  // Analytics
  getMetrics() { return this.client.get('/api/analytics/metrics'); }
  trackEvent(event: any) { return this.client.post('/api/analytics/events', event); }
}

export default APIClient;
